// Built with the Windows .NET Framework compiler; no downloaded runtime or Node ABI.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public static class PinataJobLauncher
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 2097152 };
    static readonly JavaScriptSerializer InputJson = new JavaScriptSerializer { MaxJsonLength = 2097152 };
    static readonly object OutputLock = new object();
    static IntPtr job, root;
    static FileStream input;
    static Thread stdoutReader, stderrReader, exitReader;
    static volatile Thread inputWriter;
    static string jobName, launcherId, fault;
    static bool started, stopped, ownsJob;

    static void Send(object value)
    {
        lock (OutputLock)
        {
            Console.WriteLine(Json.Serialize(value));
            Console.Out.Flush();
        }
    }
    static void Check(bool success, string operation)
    {
        if (!success)
            throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    static void Close(ref IntPtr handle)
    {
        if (handle != IntPtr.Zero)
        {
            Check(CloseHandle(handle), "CloseHandle");
            handle = IntPtr.Zero;
        }
    }
    static string Text(Dictionary<string, object> value, string key)
    {
        return (string)value[key];
    }
    static void Boundary(string phase)
    {
        if (fault != phase)
            return;
        Send(new { kind = "fault", phase = phase, pid = root == IntPtr.Zero ? 0 : GetProcessId(root) });
        Process.GetCurrentProcess().Kill();
        Thread.Sleep(Timeout.Infinite);
    }

    public static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args.Length == 2 && args[0] == "observe")
            {
                Send(new { process = Observe(Int32.Parse(args[1])) });
                return 0;
            }
            if (args.Length < 2 || args.Length > 3)
                throw new ArgumentException("Expected job name, launcher UUID and optional fault boundary");
            jobName = args[0];
            launcherId = Guid.Parse(args[1]).ToString();
            fault = args.Length == 3 ? args[2] : null;
            job = CreateJobObjectW(IntPtr.Zero, jobName);
            Check(job != IntPtr.Zero, "CreateJobObjectW");
            if (Marshal.GetLastWin32Error() == 183)
                throw new InvalidOperationException("Job name already exists");
            ownsJob = true;
            Boundary("job-created");
            var limits = new ExtendedLimits();
            limits.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE; neither breakaway flag is enabled.
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))),
                  "SetInformationJobObject");
            Boundary("limits-set");
            Send(new { kind = "ready", jobName = jobName, launcherId = launcherId,
                       process = Observe(Process.GetCurrentProcess().Id) });
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                if (line.Length > 2097152)
                    throw new InvalidOperationException("Helper request is too large");
                var request = (Dictionary<string, object>)InputJson.DeserializeObject(line);
                var id = Convert.ToInt32(request["id"]);
                try
                {
                    object result;
                    switch (Text(request, "action"))
                    {
                    case "start":
                        result = Start((Dictionary<string, object>)request["payload"]);
                        break;
                    case "inspect":
                        result = Inspect();
                        break;
                    case "enroll":
                        int pid = Convert.ToInt32(request["pid"]);
                        using (var process = new SafeProcess(OpenProcess(0x1000, false, pid)))
                        {
                            Check(!process.IsInvalid, "OpenProcess(enroll)");
                            bool member;
                            Check(IsProcessInJob(process.DangerousGetHandle(), job, out member), "IsProcessInJob");
                            if (!member)
                                throw new InvalidOperationException("Process is outside the owned job");
                        }
                        result = Inspect();
                        break;
                    case "input":
                        if (input == null)
                            throw new InvalidOperationException("Payload input is closed");
                        var previousWriter = inputWriter;
                        if (previousWriter != null && !previousWriter.Join(0))
                            throw new InvalidOperationException("Payload input write is still pending");
                        byte[] bytes = Convert.FromBase64String(Text(request, "data"));
                        var target = input;
                        // A full pipe must not prevent the control loop from stopping the job.
                        inputWriter = new Thread(
                            () =>
                            {
                                object response;
                                try
                                {
                                    target.Write(bytes, 0, bytes.Length);
                                    target.Flush();
                                    response =
                                        new { kind = "response", id = id, ok = true, value = new { accepted = true } };
                                }
                                catch (Exception error)
                                {
                                    response = new { kind = "response", id = id, ok = false, error = error.Message };
                                }
                                // Release the writer slot before acknowledging it to the guardian.
                                lock (OutputLock)
                                {
                                    inputWriter = null;
                                    Send(response);
                                }
                            });
                        inputWriter.IsBackground = true;
                        inputWriter.Start();
                        continue;
                    case "input_end":
                        if (inputWriter != null)
                            throw new InvalidOperationException("Payload input write is still pending");
                        if (input != null)
                        {
                            input.Dispose();
                            input = null;
                        }
                        result = new { accepted = true };
                        break;
                    case "stop":
                        Stop();
                        result = new { empty = true };
                        break;
                    case "close":
                        if (!stopped || ActiveCount() != 0)
                            throw new InvalidOperationException("Job is not confirmed empty");
                        JoinReaders();
                        Close(ref job);
                        Send(new { kind = "response", id = id, ok = true,
                                   value = new { jobName = jobName, launcherId = launcherId, activeProcesses = 0,
                                                 closed = true } });
                        return 0;
                    default:
                        throw new InvalidOperationException("Unknown helper action");
                    }
                    Send(new { kind = "response", id = id, ok = true, value = result });
                }
                catch (Exception error)
                {
                    Send(new { kind = "response", id = id, ok = false, error = error.Message });
                }
            }
            // The guardian died or closed its pipe. The helper never abandons a live job.
            Stop();
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
        finally
        {
            if (job != IntPtr.Zero)
            {
                if (ownsJob)
                    TerminateJobObject(job, 1);
                CloseHandle(job);
            }
            if (root != IntPtr.Zero)
                CloseHandle(root);
            if (input != null)
                input.Dispose();
        }
    }

    static object Start(Dictionary<string, object> payload)
    {
        if (started || stopped)
            throw new InvalidOperationException("Payload already started or job stopped");
        started = true;
        IntPtr childIn = IntPtr.Zero, parentIn = IntPtr.Zero, parentOut = IntPtr.Zero, childOut = IntPtr.Zero,
               parentErr = IntPtr.Zero, childErr = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, jobs = IntPtr.Zero, handles = IntPtr.Zero, environment = IntPtr.Zero;
        bool initialized = false;
        var pi = new ProcessInfo();
        try
        {
            var security =
                new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), InheritHandle = true };
            Check(CreatePipe(out childIn, out parentIn, ref security, 0), "CreatePipe(stdin)");
            Check(CreatePipe(out parentOut, out childOut, ref security, 0), "CreatePipe(stdout)");
            Check(CreatePipe(out parentErr, out childErr, ref security, 0), "CreatePipe(stderr)");
            foreach (IntPtr handle in new[] { parentIn, parentOut, parentErr })
                Check(SetHandleInformation(handle, 1, 0), "SetHandleInformation");
            Boundary("pipes-created");
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            if (size == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Attribute list size");
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "InitializeProcThreadAttributeList");
            initialized = true;
            Boundary("attributes-created");
            jobs = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobs, job);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobs, new IntPtr(IntPtr.Size),
                                            IntPtr.Zero, IntPtr.Zero),
                  "Job-list attribute");
            Boundary("job-attribute");
            handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
            Marshal.WriteIntPtr(handles, 0, childIn);
            Marshal.WriteIntPtr(handles, IntPtr.Size, childOut);
            Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, childErr);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(3 * IntPtr.Size),
                                            IntPtr.Zero, IntPtr.Zero),
                  "Handle-list attribute");
            Boundary("handle-attribute");
            var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in (Dictionary<string, object>)payload["env"])
            {
                string value = (string)entry.Value;
                if (entry.Key.Length == 0 || entry.Key.IndexOf('\0') >= 0 || value.IndexOf('\0') >= 0 ||
                    (entry.Key.IndexOf('=') >= 0 &&
                     !(entry.Key.Length == 3 && entry.Key[0] == '=' && entry.Key[2] == ':')))
                    throw new ArgumentException("Invalid environment entry");
                env[entry.Key] = value;
            }
            environment = Marshal.StringToHGlobalUni(
                String.Join("\0", env.Select(entry => entry.Key + "=" + entry.Value).ToArray()) + "\0\0");
            string cwd = Text(payload, "cwd"), executable = Resolve(Text(payload, "command"), cwd, env);
            string[] arguments = ((object[])payload["args"]).Cast<string>().ToArray();
            string commandLine;
            if (executable.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) ||
                executable.EndsWith(".bat", StringComparison.OrdinalIgnoreCase))
            {
                // cmd is an explicit invocation boundary. Reject shell expansion syntax
                // rather than interpreting arbitrary argument data as a command language.
                foreach (string argument in new[] { executable }.Concat(arguments))
                    if (argument.IndexOfAny("\"%!^&|<>()\r\n\0".ToCharArray()) >= 0)
                        throw new ArgumentException(
                            "cmd invocation cannot encode shell metacharacters; invoke an executable directly");
                commandLine =
                    "/d /v:off /s /c \"" +
                    String.Join(" ",
                                new[] { executable }.Concat(arguments).Select(value => "\"" + value + "\"").ToArray()) +
                    "\"";
                executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
                commandLine = Quote(executable) + " " + commandLine;
            }
            else
                commandLine = String.Join(" ", new[] { executable }.Concat(arguments).Select(Quote).ToArray());
            if (commandLine.Length >= 32767)
                throw new ArgumentException("Windows command line exceeds 32766 characters");
            var si = new StartupInfoEx();
            si.StartupInfo.Size = Marshal.SizeOf(typeof(StartupInfoEx));
            si.StartupInfo.Flags = 0x100;
            si.StartupInfo.Input = childIn;
            si.StartupInfo.Output = childOut;
            si.StartupInfo.Error = childErr;
            si.Attributes = attributes;
            Boundary("before-create");
            Check(CreateProcessW(executable, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true,
                                 0x80000 | 0x400 | 0x8000000, environment, cwd, ref si, out pi),
                  "CreateProcessW");
            root = pi.Process;
            pi.Process = IntPtr.Zero;
            Boundary("after-create");
            bool member;
            Check(IsProcessInJob(root, job, out member), "IsProcessInJob(root)");
            if (!member)
                throw new InvalidOperationException("Root was not enrolled at creation");
            var identity = Describe(root, pi.ProcessId, Process.GetCurrentProcess().Id);
            Close(ref childIn);
            Close(ref childOut);
            Close(ref childErr);
            Close(ref pi.Thread);
            input = new FileStream(new SafeFileHandle(parentIn, true), FileAccess.Write);
            parentIn = IntPtr.Zero;
            stdoutReader = ReadOutput(parentOut, "stdout");
            parentOut = IntPtr.Zero;
            stderrReader = ReadOutput(parentErr, "stderr");
            parentErr = IntPtr.Zero;
            exitReader = new Thread(() =>
                                    {
                                        WaitForSingleObject(root, 0xFFFFFFFF);
                                        uint code;
                                        if (!GetExitCodeProcess(root, out code))
                                        {
                                            Send(new { kind = "failure", error = "GetExitCodeProcess failed" });
                                            return;
                                        }
                                        Send(new { kind = "exit", code = unchecked((int)code) });
                                        stdoutReader.Join();
                                        stderrReader.Join();
                                        Send(new { kind = "drained" });
                                    });
            exitReader.IsBackground = true;
            exitReader.Start();
            return new { root = identity, membership = "creation-time-job-list" };
        }
        catch
        {
            Stop();
            throw;
        }
        finally
        {
            foreach (IntPtr handle in new[] { childIn, parentIn, parentOut, childOut, parentErr, childErr, pi.Process,
                                              pi.Thread })
                if (handle != IntPtr.Zero)
                    CloseHandle(handle);
            if (initialized)
                DeleteProcThreadAttributeList(attributes);
            foreach (IntPtr memory in new[] { attributes, jobs, handles, environment })
                if (memory != IntPtr.Zero)
                    Marshal.FreeHGlobal(memory);
        }
    }

    static Thread ReadOutput(IntPtr handle, string stream)
    {
        var reader =
            new Thread(() =>
                       {
                           try
                           {
                               using (var file = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read))
                               {
                                   var buffer = new byte[65536];
                                   int count;
                                   while ((count = file.Read(buffer, 0, buffer.Length)) != 0)
                                       Send(new { kind = "output", stream = stream,
                                                  data = Convert.ToBase64String(buffer, 0, count) });
                               }
                           }
                           catch (IOException error)
                           {
                               Send(new { kind = "failure", error = error.Message });
                           }
                       });
        reader.IsBackground = true;
        reader.Start();
        return reader;
    }
    static void JoinReaders()
    {
        if (exitReader != null && !exitReader.Join(5000))
            throw new TimeoutException("Payload output did not drain");
    }
    static uint ActiveCount()
    {
        var info = new Accounting();
        Check(QueryAccounting(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero),
              "QueryInformationJobObject(accounting)");
        return info.ActiveProcesses;
    }
    static void Stop()
    {
        stopped = true;
        Check(TerminateJobObject(job, 1), "TerminateJobObject");
        var timer = Stopwatch.StartNew();
        while (ActiveCount() != 0)
        {
            if (timer.ElapsedMilliseconds > 5000)
                throw new TimeoutException("Job still has active processes");
            Thread.Sleep(10);
        }
        var writer = inputWriter;
        if (writer != null && !writer.Join(5000))
            throw new TimeoutException("Payload input did not release after job termination");
        if (input != null)
        {
            input.Dispose();
            input = null;
        }
    }
    static object Inspect()
    {
        int size = 1024;
        for (;;)
        {
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                if (!QueryInformationJobObject(job, 3, buffer, (uint)size, IntPtr.Zero))
                {
                    if (Marshal.GetLastWin32Error() == 234 && size < 16777216)
                    {
                        size *= 2;
                        continue;
                    }
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "QueryInformationJobObject(process list)");
                }
                int count = Marshal.ReadInt32(buffer, 4);
                var processes = new List<object>();
                for (int i = 0; i < count; i++)
                {
                    int pid = checked((int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
                    object process = Observe(pid);
                    if (process != null)
                        processes.Add(process);
                }
                return new { activeProcesses = ActiveCount(), processes = processes };
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
    }
    static object Observe(int pid)
    {
        using (var handle = new SafeProcess(OpenProcess(0x101000, false, pid)))
        {
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                if (error == 87)
                    return null;
                throw new Win32Exception(error, "OpenProcess(observe)");
            }
            uint state = WaitForSingleObject(handle.DangerousGetHandle(), 0);
            if (state == 0)
                return null;
            Check(state == 258, "WaitForSingleObject(observe)");
            return Describe(handle.DangerousGetHandle(), pid, 0);
        }
    }
    static object Describe(IntPtr handle, int pid, int parent)
    {
        long created, exited, kernel, user;
        Check(GetProcessTimes(handle, out created, out exited, out kernel, out user), "GetProcessTimes");
        return new { pid = pid, parent = parent, group = 0, startIdentity = "win32:" + created, state = "R" };
    }
    static string Resolve(string command, string cwd, SortedDictionary<string, string> env)
    {
        if (command.IndexOf('\0') >= 0)
            throw new ArgumentException("Executable contains NUL");
        if (Path.IsPathRooted(command) || command.IndexOfAny(new[] { '/', '\\' }) >= 0)
        {
            string path = Path.GetFullPath(Path.Combine(cwd, command));
            if (File.Exists(path))
                return path;
            if (!Path.HasExtension(path) && File.Exists(path + ".exe"))
                return path + ".exe";
        }
        else
        {
            string path;
            if (env.TryGetValue("PATH", out path))
                foreach (string directory in path.Split(';'))
                {
                    if (String.IsNullOrWhiteSpace(directory))
                        continue;
                    string candidate = Path.GetFullPath(Path.Combine(cwd, directory.Trim('"'), command));
                    if (!Path.HasExtension(candidate))
                        candidate += ".exe";
                    if (File.Exists(candidate))
                        return Path.GetFullPath(candidate);
                }
        }
        throw new FileNotFoundException("Executable was not found on the supplied PATH");
    }
    static string Quote(string value)
    {
        if (value.IndexOf('\0') >= 0)
            throw new ArgumentException("Argument contains NUL");
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\')
            {
                slashes++;
                continue;
            }
            if (c == '"')
                result.Append('\\', slashes * 2 + 1);
            else
                result.Append('\\', slashes);
            result.Append(c);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    sealed class SafeProcess : SafeHandleZeroOrMinusOneIsInvalid
    {
        public SafeProcess(IntPtr value) : base(true)
        {
            SetHandle(value);
        }
        protected override bool ReleaseHandle()
        {
            return CloseHandle(handle);
        }
    }
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes
    {
        public int Length;
        public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)]
        public bool InheritHandle;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting
    {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaultCount, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int Size;
        public IntPtr Reserved;
        public string Desktop, Title;
        public int X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public short ShowWindow, ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr Attributes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public int ProcessId, ThreadId;
    }
    [DllImport("kernel32.dll", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr security, string name);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits value, uint size);
    [DllImport("kernel32.dll", ExactSpelling = true, EntryPoint = "QueryInformationJobObject", SetLastError = true)]
    static extern bool QueryAccounting(IntPtr job, int kind, out Accounting value, uint size, IntPtr returned);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr value, uint size, IntPtr returned);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes security, uint size);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size,
                                                 IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity,
                                      IntPtr threadSecurity, bool inheritHandles, uint flags, IntPtr environment,
                                      string cwd, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel,
                                       out long user);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
}
