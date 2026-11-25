import { randomUUID } from "node:crypto";
import {
  assignmentKey,
  commandEnvelopeSchema,
  type Assignment,
  type AssignmentRef,
  type CommandEnvelope,
  type CommandReceipt,
  type Config,
  type ConversationQueryResult,
  type ConversationPreview,
  conversationPreviewSchema,
  type CoreState,
  type DefinitionSummary,
  type QueryResult,
  type RuntimeEvent,
  type SurfaceReply,
} from "../contracts/index.ts";
import { dependentAssignments, readinessFor, indexSnapshot } from "../core/indexes.ts";
import { reduce } from "../core/state.ts";
import { type RuntimeSource, surfaceError } from "../sources/runtime.ts";
import {
  assignments,
  fleetFilters,
  matchesFleetFilter,
  steerTarget,
  type FleetFilter,
} from "./projection.ts";
import { type PaletteName } from "./palette.ts";
import { assignmentTree } from "./tree.ts";

export type ScreenName = "main" | "fleet" | "conversation";
export type MessageAction = "steer" | "follow_up" | "continue";
export type DependencyGroup = "prerequisites" | "dependents";
type DependencyLink = {
  kind: "link";
  key: string;
  group: DependencyGroup;
  assignment: Assignment;
};
export type DependencyRow =
  | DependencyLink
  | {
      kind: "group";
      key: DependencyGroup;
      group: DependencyGroup;
      expanded: boolean;
      total: number;
      completed: number;
      attention: number;
    };
type FleetLocation = {
  ref: AssignmentRef;
  focusedDependency?: string;
  revealedAssignment?: AssignmentRef;
  expandedGroups: ReadonlySet<DependencyGroup>;
  scroll: number;
  renderedSelection?: string;
  inspectorFocus: boolean;
  inspectorScroll: number;
};
export type ConversationView = {
  page?: ConversationQueryResult;
  loading: boolean;
  error?: string;
  scroll: number;
  maxScroll?: number;
  refreshPending?: boolean;
  inspection?: QueryResult;
  worktreePatch?: string;
  follow?: boolean;
  newOutput?: boolean;
};
type PendingMessage = {
  text: string;
  action: MessageAction;
  ref: AssignmentRef;
  envelope: CommandEnvelope;
};
export type RouterOptions = {
  ui?: Partial<Config["ui"]>;
  mode?: Config["mode"];
  changed?(): void;
  accepted?(receipt: Extract<CommandReceipt, { status: "accepted" }>, messageId?: string): void;
  now?(): number;
  project?: string;
};
export type PreviewView = {
  result?: ConversationPreview;
  error?: string;
  loading: boolean;
  revision?: number;
};

// A single router owns selection and drafts across the Pi screen and standalone
// viewer. Sources own authority, execution, reconnect and full retained evidence.
export class ScreenRouter {
  readonly source: RuntimeSource;
  state: CoreState;
  screen: ScreenName = "main";
  selected?: AssignmentRef;
  definition?: DefinitionSummary;
  palette: PaletteName;
  mode: Config["mode"];
  motion: Config["ui"]["motion"];
  readonly keys: Record<string, string>;
  private noticeText = "";
  noticeTone: "success" | "warning" = "warning";
  fleetScroll = 0;
  fleetPageSize = 1;
  fleetRenderedSelection?: string;
  inspectorFocus = false;
  inspectorScroll = 0;
  inspectorMaxScroll = 0;
  inspectorPageSize = 1;
  inspectorVisible = false;
  connectionAvailable = true;
  help = false;
  helpScroll = 0;
  focusedDependency?: string;
  private readonly dependencyDisclosure = new Map<string, boolean>();
  private revealedAssignment?: AssignmentRef;
  private readonly dependencyHistory: FleetLocation[] = [];
  private conversationFleetLocation?: FleetLocation;
  private restoredExpandedGroups?: ReadonlySet<DependencyGroup>;
  private release?: { from: AssignmentRef; targets: AssignmentRef[]; at: number };
  private fleetCache?: {
    state: CoreState;
    search: string;
    filter: FleetFilter;
    ascii: boolean;
    revealed?: AssignmentRef;
    nodes: ReturnType<typeof assignmentTree>;
  };
  private searchCache?: {
    state: CoreState;
    search: string;
    matched: ReturnType<typeof assignments>;
  };
  actions = false;
  actionIndex = 0;
  search = "";
  searchBeforeEdit = "";
  searchSelected?: AssignmentRef;
  definitionScroll = 0;
  searching = false;
  filter: FleetFilter = "unfinished";
  private filterReturn?: { filter: FleetFilter; selected?: AssignmentRef };
  readonly collapsed = new Set<string>();
  transcriptFocus = false;
  details = false;
  transcriptDetails = false;
  expandedTools = false;
  showThinking = false;
  readonly activity = new Map<string, string>();
  private readonly drafts = new Map<string, string>();
  private readonly conversations = new Map<string, ConversationView>();
  private readonly messages = new Map<string, PendingMessage>();
  private readonly listeners = new Set<() => void>();
  private readonly options: RouterOptions;
  private unsubscribe?: () => void;
  private disconnect?: () => void;
  private alive = true;
  private connected = false;
  private generation = 0;
  private readonly activityOrdinals = new Map<string, number>();
  private epoch: string;
  private localPalette = false;
  private readonly observedTimes = new Map<string, { start: number; end?: number }>();
  private ticker?: NodeJS.Timeout;
  private lastConversationRead = -Infinity;
  private lastPreviewRead = -Infinity;
  private previewTimer?: NodeJS.Timeout;
  private patchRequest?: AbortController;
  private previewRequest?: AbortController;
  private previewGeneration = 0;
  private readonly previews = new Map<string, PreviewView>();

  constructor(source: RuntimeSource, options: RouterOptions = {}) {
    this.source = source;
    this.options = options;
    const initial = source.snapshot();
    this.state = indexSnapshot(initial.snapshot);
    this.epoch = initial.ownerEpoch;
    this.palette = options.ui?.palette ?? "inherit";
    this.mode = options.mode ?? "lean";
    this.motion = options.ui?.motion ?? "full";
    this.keys = { ...options.ui?.keys };
    this.selected = assignments(this.state)[0]?.ref;
  }

  get notice(): string {
    return this.noticeText;
  }
  get project(): string | undefined {
    return this.options.project;
  }
  set notice(text: string) {
    this.noticeText = text;
    this.noticeTone = "warning";
  }

  async start(): Promise<void> {
    if (this.connected || !this.alive) return;
    this.connected = true;
    this.disconnect = this.source.onConnectionChange?.((connected) => {
      this.connectionAvailable = connected;
      if (!connected) this.clearTiming();
      this.cancelPreview();
      this.notice = connected
        ? "Reconnected to the owning runtime; retained drafts are unchanged"
        : "Connection unavailable. /reconnect refreshes authority; drafts and pending receipt IDs are retained";
      this.changed();
      if (connected) {
        if (this.selected) this.preview().revision = undefined;
        this.schedulePreview();
      }
    });
    const unsubscribe = await this.source.subscribe((event) => this.receive(event));
    if (this.alive) this.unsubscribe = unsubscribe;
    else unsubscribe();
    await this.loadSettings();
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    this.updateTicker();
    return () => {
      this.listeners.delete(listener);
      this.updateTicker();
    };
  }
  private changed(): void {
    if (!this.alive) return;
    this.options.changed?.();
    for (const listener of this.listeners) listener();
  }
  private receive(event: RuntimeEvent): void {
    if (!this.alive) return;
    const changedOwner = event.ownerEpoch !== this.epoch;
    if (changedOwner) {
      this.epoch = event.ownerEpoch;
      this.clearDependencyNavigation();
      this.dependencyDisclosure.clear();
      this.patchRequest?.abort();
      this.generation++;
      this.activity.clear();
      this.activityOrdinals.clear();
      this.cancelPreview();
      this.previews.clear();
      this.clearTiming();
      for (const conversation of this.conversations.values())
        if (conversation.page) conversation.page.cursor = undefined;
    }
    if (event.kind === "activity") {
      if (this.mode === "lean") return;
      const key = assignmentKey(event.ref);
      const source = `${this.epoch}/${event.source}`;
      if ((this.activityOrdinals.get(source) ?? -1) >= event.ordinal) return;
      this.activityOrdinals.set(source, event.ordinal);
      if (this.activityOrdinals.size > 256)
        this.activityOrdinals.delete(this.activityOrdinals.keys().next().value ?? "");
      this.activity.set(
        key,
        `${event.snapshot ? "" : (this.activity.get(key) ?? "")}${event.text}`.slice(-4096),
      );
      if (this.activity.size > 64) this.activity.delete(this.activity.keys().next().value ?? "");
      this.changed();
      return;
    }
    const previous = this.state;
    if (event.kind === "snapshot") {
      if (!changedOwner && event.revision < this.state.revision) return;
      if (event.revision !== this.state.revision) this.clearTiming();
      this.state = indexSnapshot(event.snapshot);
    } else if (!changedOwner && event.revision <= this.state.revision) return;
    else if (!changedOwner && event.revision === this.state.revision + 1)
      this.state = reduce(this.state, event.transition, event.revision);
    else {
      // A gap or a new owner requires an authoritative reset. Ordinary commits
      // use the shared reducer without copying the full retained run state.
      this.clearTiming();
      this.receive(this.source.snapshot());
      return;
    }
    if (event.kind === "committed" && previous.assignments !== this.state.assignments) {
      for (const [key, assignment] of Object.entries(this.state.assignments)) {
        const before = previous.assignments[key]?.execution.phase;
        if (before === "queued" && !["queued", "ended"].includes(assignment.execution.phase))
          this.observedTimes.set(key, { start: this.now() });
        const timing = this.observedTimes.get(key);
        if (timing && timing.end === undefined && assignment.execution.phase === "ended")
          timing.end = this.now();
      }
    }
    if (event.kind === "committed" && event.transition.kind === "settled") {
      const from = event.transition.result.ref;
      const targets = dependentAssignments(this.state, assignmentKey(from))
        .filter(
          (a) =>
            readinessFor(previous, assignmentKey(a.ref)) === "dependency" &&
            readinessFor(this.state, assignmentKey(a.ref)) === "ready",
        )
        .map((a) => a.ref);
      if (targets.length) this.release = { from, targets, at: this.now() };
    }
    if (event.kind === "snapshot" || previous.assignments !== this.state.assignments)
      this.updateTicker();
    if (previous.config?.digest !== this.state.config?.digest)
      void this.loadSettings().catch((error: unknown) => this.fail(error));
    if (!this.selected && !this.definition) this.selected = assignments(this.state)[0]?.ref;
    const previousSelection = this.selected && assignmentKey(this.selected);
    if (this.screen === "fleet") {
      const rows = this.fleetAssignments();
      if (
        !rows.some(
          (row) => this.selected && assignmentKey(row.ref) === assignmentKey(this.selected),
        )
      )
        this.selected = this.preferredSelection(rows);
      if (previousSelection !== (this.selected && assignmentKey(this.selected))) {
        this.cancelPreview();
        this.inspectorScroll = 0;
        this.focusedDependency = undefined;
        this.restoredExpandedGroups = undefined;
      }
    }
    this.changed();
    if (
      event.kind === "snapshot" ||
      (event.kind === "committed" &&
        (event.transition.kind === "settled" || event.transition.kind === "response_observed")) ||
      previousSelection !== (this.selected && assignmentKey(this.selected))
    )
      this.schedulePreview();
    if (
      this.screen === "conversation" &&
      this.selected &&
      event.kind === "committed" &&
      (event.transition.kind === "settled" || event.transition.kind === "response_observed")
    )
      void this.loadConversation().catch((error: unknown) => this.fail(error));
  }
  private dependencyLinks(): DependencyLink[] {
    const selected = this.selected && this.state.assignments[assignmentKey(this.selected)];
    if (!selected) return [];
    const links: DependencyLink[] = [];
    for (const ref of selected.after) {
      const key = assignmentKey(ref);
      const assignment = this.state.assignments[key];
      if (assignment) links.push({ kind: "link", group: "prerequisites", key, assignment });
    }
    for (const assignment of dependentAssignments(this.state, assignmentKey(selected.ref))) {
      links.push({
        kind: "link",
        group: "dependents",
        key: assignmentKey(assignment.ref),
        assignment,
      });
    }
    return links;
  }
  get hasDependencies(): boolean {
    const selected = this.selected && this.state.assignments[assignmentKey(this.selected)];
    return Boolean(
      selected &&
      (selected.after.length ||
        dependentAssignments(this.state, assignmentKey(selected.ref)).length),
    );
  }
  dependencyRows(): DependencyRow[] {
    if (!this.selected || this.selectedBranchCollapsed) return [];
    const links = this.dependencyLinks();
    const rows: DependencyRow[] = [];
    for (const group of ["prerequisites", "dependents"] as const) {
      const related = links.filter((link) => link.group === group);
      if (!related.length) continue;
      const completed: DependencyLink[] = [];
      const attention: DependencyLink[] = [];
      const pending: DependencyLink[] = [];
      for (const link of related) {
        const execution = link.assignment.execution;
        if (execution.phase !== "ended") pending.push(link);
        else if (execution.reason === "completed" && execution.cleanup === "confirmed")
          completed.push(link);
        else attention.push(link);
      }
      const expanded =
        this.dependencyDisclosure.get(this.disclosureKey(this.selected, group)) ??
        (this.restoredExpandedGroups?.has(group) ||
          completed.length !== related.length ||
          completed.some((link) => link.key === this.focusedDependency));
      rows.push({
        kind: "group",
        key: group,
        group,
        expanded,
        total: related.length,
        completed: completed.length,
        attention: attention.length,
      });
      if (expanded) rows.push(...attention, ...pending, ...completed);
    }
    return rows;
  }
  private disclosureKey(ref: AssignmentRef, group: DependencyGroup): string {
    return group + assignmentKey(ref);
  }
  private toggleDependencyGroup(group: DependencyGroup, expanded?: boolean): void {
    if (!this.selected) return;
    const row = this.dependencyRows().find((row) => row.kind === "group" && row.group === group);
    if (row?.kind !== "group") return;
    this.dependencyDisclosure.set(
      this.disclosureKey(this.selected, group),
      expanded ?? !row.expanded,
    );
    this.focusDependency(group);
  }
  private focusDependency(key?: string): void {
    this.focusedDependency = key;
    this.changed();
  }
  activateDependency(key = this.focusedDependency): void {
    const row = this.dependencyRows().find((row) => row.key === key);
    if (!row) return;
    if (row.kind === "group") this.toggleDependencyGroup(row.group);
    else {
      this.focusedDependency = row.key;
      this.navigate("conversation", row.assignment.ref);
    }
  }
  moveFleetBranch(direction: "left" | "right"): void {
    if (direction === "left") {
      if (this.focusedDependency) this.focusDependency();
      else if (this.selected && !this.selectedBranchCollapsed) {
        const key = assignmentKey(this.selected);
        const node = this.fleetNodes().find((row) => assignmentKey(row.assignment.ref) === key);
        if (node?.hasChildren || this.hasDependencies) this.collapse(true);
      }
      return;
    }
    if (this.selectedBranchCollapsed) this.collapse(false);
    const rows = this.dependencyRows();
    const focused = rows.find((row) => row.key === this.focusedDependency);
    if (focused?.kind === "link") {
      this.followDependency(focused.key);
      return;
    }
    const groups = rows.filter((row) => row.kind === "group");
    const group = focused ?? (groups.length === 1 ? groups[0] : undefined);
    if (!group) {
      if (groups.length) this.focusDependency(groups[0].key);
      return;
    }
    if (!group.expanded) this.toggleDependencyGroup(group.key, true);
    const links = group.expanded ? rows : this.dependencyRows();
    const first = links.find((row) => row.kind === "link" && row.group === group.group);
    this.focusDependency(first?.key ?? group.key);
  }
  private captureFleetLocation(): FleetLocation | undefined {
    if (!this.selected) return undefined;
    const expandedGroups = this.dependencyRows().flatMap((row) =>
      row.kind === "group" && row.expanded ? [row.group] : [],
    );
    return {
      ref: this.selected,
      focusedDependency: this.focusedDependency,
      revealedAssignment: this.revealedAssignment,
      expandedGroups: new Set(expandedGroups),
      scroll: this.fleetScroll,
      renderedSelection: this.fleetRenderedSelection,
      inspectorFocus: this.inspectorFocus,
      inspectorScroll: this.inspectorScroll,
    };
  }
  followDependency(key = this.focusedDependency): void {
    const target = this.dependencyLinks().find((link) => link.key === key);
    if (!target) return;
    const origin = this.captureFleetLocation();
    if (!origin) return;
    this.dependencyHistory.push(origin);
    this.revealedAssignment = target.assignment.ref;
    this.navigate("fleet", target.assignment.ref);
  }
  get canReturnToDependencyOrigin(): boolean {
    return this.dependencyHistory.length > 0;
  }
  returnToDependencyOrigin(): void {
    const origin = this.dependencyHistory.pop();
    if (origin) this.navigate("fleet", undefined, origin);
  }
  clearDependencyNavigation(): void {
    this.focusedDependency = undefined;
    this.revealedAssignment = undefined;
    this.dependencyHistory.length = 0;
    this.conversationFleetLocation = undefined;
    this.restoredExpandedGroups = undefined;
  }
  handoff(ascii: boolean): string | undefined {
    const release = this.release;
    if (!release || !this.selected || this.now() - release.at >= 2200) return;
    const key = assignmentKey(this.selected);
    const target =
      release.targets.find((ref) => assignmentKey(ref) === key) ??
      (assignmentKey(release.from) === key ? release.targets[0] : undefined);
    if (!target) return;
    const step = Math.min(3, Math.floor((this.now() - release.at) / 250));
    const trail =
      this.motion === "full" && !ascii ? "─".repeat(step) + "◆" + "─".repeat(3 - step) : "->";
    return `${release.from.worker} ${trail} ${target.worker} ready`;
  }
  private fail(error: unknown): void {
    this.notice = surfaceError(error).message;
    this.changed();
  }

  navigate(screen: ScreenName, ref?: AssignmentRef, location?: FleetLocation): boolean {
    if (screen === "fleet" && this.screen === "conversation" && !ref)
      location ??= this.conversationFleetLocation;
    if (location && !Object.hasOwn(this.state.assignments, assignmentKey(location.ref)))
      location = undefined;
    if (location) ref = location.ref;
    if (
      ref &&
      (ref.run !== this.state.run || !Object.hasOwn(this.state.assignments, assignmentKey(ref)))
    ) {
      this.notice = "That assignment is unavailable in this run";
      this.changed();
      return false;
    }
    this.patchRequest?.abort();
    if (screen === "conversation" && this.screen === "fleet")
      this.conversationFleetLocation = this.captureFleetLocation();
    else if (screen !== "conversation") this.conversationFleetLocation = undefined;
    this.focusedDependency = undefined;
    this.restoredExpandedGroups = location?.expandedGroups;
    const previous = this.selected && assignmentKey(this.selected);
    if (this.noticeTone === "success") this.notice = "";
    if (ref) {
      this.selected = { ...ref };
      this.definition = undefined;
    }
    if (screen === "fleet") {
      if (location) {
        const originKey = assignmentKey(location.ref);
        this.revealedAssignment = location.revealedAssignment;
        if (!this.fleetNodes().some((node) => assignmentKey(node.assignment.ref) === originKey))
          this.revealedAssignment = location.ref;
      } else if (
        ref &&
        this.revealedAssignment &&
        assignmentKey(ref) !== assignmentKey(this.revealedAssignment)
      ) {
        const key = assignmentKey(ref);
        const wasVisible = this.fleetNodes().some(
          (row) => assignmentKey(row.assignment.ref) === key,
        );
        this.revealedAssignment = undefined;
        if (
          wasVisible &&
          !this.fleetNodes().some((row) => assignmentKey(row.assignment.ref) === key)
        )
          this.revealedAssignment = ref;
      }
      this.definition = undefined;
      const rows = this.fleetAssignments();
      if (
        !rows.some(
          (row) => this.selected && assignmentKey(row.ref) === assignmentKey(this.selected),
        )
      )
        this.selected = this.preferredSelection(rows);
    }
    this.screen = screen;
    if (location) {
      this.focusedDependency = location.focusedDependency;
      if (
        this.focusedDependency &&
        !this.dependencyRows().some((row) => row.key === this.focusedDependency)
      )
        this.focusedDependency = undefined;
      this.fleetScroll = location.scroll;
      this.fleetRenderedSelection = location.renderedSelection;
      this.inspectorFocus = location.inspectorFocus;
      this.inspectorScroll = location.inspectorScroll;
    } else if (previous !== (this.selected && assignmentKey(this.selected)))
      this.inspectorScroll = 0;
    this.cancelPreview();
    if (screen === "conversation" && this.selected) {
      const view = this.conversation();
      view.follow = true;
      view.newOutput = false;
    }
    this.generation++;
    this.changed();
    if (screen === "fleet") this.schedulePreview();
    if (screen === "conversation" && this.selected)
      void this.loadConversation().catch((error: unknown) => this.fail(error));
    return true;
  }
  cycleWorker(direction: number): void {
    const visible = this.screen === "fleet" ? this.fleetAssignments() : undefined;
    const workers = visible
      ? [...new Set(visible.map((assignment) => assignment.ref.worker))]
      : Object.keys(this.state.workers);
    if (!workers.length) return;
    const selected = this.selected ? workers.indexOf(this.selected.worker) : 0;
    const worker = workers[(selected + direction + workers.length) % workers.length];
    this.navigate(this.screen, {
      run: this.state.run,
      worker,
      assignment:
        visible?.filter((assignment) => assignment.ref.worker === worker).at(-1)?.ref.assignment ??
        this.state.latest[worker],
    });
  }
  cycleAssignment(direction: number): void {
    if (!this.selected) return;
    const history = assignments(this.state).filter(
      (assignment) => assignment.ref.worker === this.selected?.worker,
    );
    const current = history.findIndex(
      (assignment) =>
        assignmentKey(assignment.ref) === assignmentKey(this.selected as AssignmentRef),
    );
    this.navigate(
      "conversation",
      history[(current + direction + history.length) % history.length]?.ref,
    );
  }
  fleetAssignments(): ReturnType<typeof assignments> {
    return this.fleetNodes().map((node) => node.assignment);
  }
  fleetNodes(ascii = false): ReturnType<typeof assignmentTree> {
    const cached = this.fleetCache;
    if (
      cached?.state === this.state &&
      cached.filter === this.filter &&
      cached.search === this.search &&
      cached.revealed === this.revealedAssignment &&
      cached.ascii === ascii
    )
      return cached.nodes;
    const include = new Set(
      this.matchingAssignments()
        .filter((assignment) => matchesFleetFilter(this.state, assignment, this.filter))
        .map((assignment) => assignmentKey(assignment.ref)),
    );
    const revealedPath = new Set<string>();
    let revealed = this.revealedAssignment;
    if (revealed) include.add(assignmentKey(revealed));
    while (revealed) {
      const key = assignmentKey(revealed);
      if (revealedPath.has(key)) break;
      revealedPath.add(key);
      revealed = this.state.workers[revealed.worker]?.parentAssignment;
    }
    const nodes = assignmentTree(this.state, {
      ascii,
      include,
    });
    const hidden = new Set<string>();
    const visible = nodes.filter((node) => {
      const assignment = node.assignment;
      const key = assignmentKey(assignment.ref);
      const worker = this.state.workers[assignment.ref.worker];
      const parent = worker.parentAssignment ? assignmentKey(worker.parentAssignment) : undefined;
      if (parent && !revealedPath.has(key) && (hidden.has(parent) || this.collapsed.has(parent))) {
        hidden.add(key);
        return false;
      }
      return true;
    });
    this.fleetCache = {
      state: this.state,
      search: this.search,
      filter: this.filter,
      ascii,
      revealed: this.revealedAssignment,
      nodes: visible,
    };
    return visible;
  }
  moveFleetSelection(amount: number): void {
    if (this.focusedDependency) {
      const dependencies = this.dependencyRows();
      const index = dependencies.findIndex((row) => row.key === this.focusedDependency);
      if (index >= 0) {
        const next = dependencies[index + amount];
        if (next) this.focusDependency(next.key);
        return;
      }
    }
    const rows = this.fleetNodes();
    const selected = this.selected && assignmentKey(this.selected);
    const index = rows.findIndex((row) => assignmentKey(row.assignment.ref) === selected);
    const next = rows[index < 0 ? 0 : index + amount];
    if (next) this.navigate("fleet", next.assignment.ref);
  }
  matchingAssignments(): ReturnType<typeof assignments> {
    if (this.searchCache?.state === this.state && this.searchCache.search === this.search)
      return this.searchCache.matched;
    const matched = assignments(this.state).filter((assignment) => {
      const worker = this.state.workers[assignment.ref.worker];
      return `${worker.id} ${worker.agent} ${assignment.task}`
        .toLowerCase()
        .includes(this.search.toLowerCase());
    });
    this.searchCache = { state: this.state, search: this.search, matched };
    return matched;
  }
  setFilter(filter: FleetFilter): void {
    this.clearDependencyNavigation();
    this.filter = filter;
    this.fleetScroll = 0;
    this.inspectorFocus = false;
    this.inspectorScroll = 0;
    this.refreshView();
  }
  private preferredSelection(rows: ReturnType<typeof assignments>): AssignmentRef | undefined {
    const matches = new Set(
      this.matchingAssignments()
        .filter((assignment) => matchesFleetFilter(this.state, assignment, this.filter))
        .map((assignment) => assignmentKey(assignment.ref)),
    );
    return (rows.find((assignment) => matches.has(assignmentKey(assignment.ref))) ?? rows[0])?.ref;
  }
  cycleFilter(): void {
    this.filterReturn = undefined;
    this.setFilter(fleetFilters[(fleetFilters.indexOf(this.filter) + 1) % fleetFilters.length]);
  }
  toggleFilter(filter: "queued" | "finished"): void {
    if (this.filter === filter) {
      const previous = this.filterReturn;
      this.filterReturn = undefined;
      this.setFilter(previous?.filter ?? "unfinished");
      const selected = previous?.selected;
      if (
        selected &&
        this.fleetAssignments().some(
          (assignment) => assignmentKey(assignment.ref) === assignmentKey(selected),
        )
      )
        this.navigate("fleet", selected);
      return;
    }
    this.filterReturn = { filter: this.filter, selected: this.selected };
    this.setFilter(filter);
  }
  refreshView(): void {
    this.focusedDependency = undefined;
    const previous = this.selected && assignmentKey(this.selected);
    const rows = this.fleetAssignments();
    if (
      !rows.some((row) => this.selected && assignmentKey(row.ref) === assignmentKey(this.selected))
    )
      this.selected = this.preferredSelection(rows);
    if (previous !== (this.selected && assignmentKey(this.selected))) {
      this.inspectorScroll = 0;
      this.restoredExpandedGroups = undefined;
      this.cancelPreview();
    }
    this.fleetRenderedSelection = undefined;
    this.changed();
    this.schedulePreview();
  }
  get selectedBranchCollapsed(): boolean {
    return Boolean(this.selected && this.collapsed.has(assignmentKey(this.selected)));
  }
  collapse(value: boolean): void {
    if (!this.selected) return;
    const key = assignmentKey(this.selected);
    this.fleetCache = undefined;
    if (value) this.collapsed.add(key);
    else this.collapsed.delete(key);
    this.refreshView();
  }
  toggleQueued(): void {
    this.toggleFilter("queued");
  }
  private now(): number {
    return this.options.now?.() ?? performance.now();
  }
  observedElapsed(ref: AssignmentRef): number | undefined {
    const timing = this.observedTimes.get(assignmentKey(ref));
    return timing ? Math.max(0, (timing.end ?? this.now()) - timing.start) : undefined;
  }
  private updateTicker(): void {
    const running =
      this.listeners.size > 0 &&
      (Boolean(this.release) ||
        Object.values(this.state.assignments).some(
          (assignment) => !["queued", "ended"].includes(assignment.execution.phase),
        ));
    if (running && !this.ticker) {
      this.ticker = setInterval(
        () => {
          this.changed();
          if (this.release && this.now() - this.release.at >= 2200) {
            this.release = undefined;
            this.updateTicker();
          }
          this.refreshFollowingConversation();
          if (this.now() - this.lastPreviewRead >= 1000) this.schedulePreview();
        },
        this.motion === "full" ? 250 : 1000,
      );
      this.ticker.unref();
    } else if (!running && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }
  private refreshFollowingConversation(): void {
    if (
      !this.alive ||
      !this.source.capabilities.live ||
      this.screen !== "conversation" ||
      !this.selected ||
      this.help ||
      this.actions
    )
      return;
    const assignment = this.state.assignments[assignmentKey(this.selected)];
    const view = this.conversation();
    // Retained messages can change without a response event (for example tool
    // output). Refresh only the visible follower, at most once per second.
    if (
      !assignment ||
      ["queued", "ended"].includes(assignment.execution.phase) ||
      !view.follow ||
      view.loading ||
      this.now() - this.lastConversationRead < 1000
    )
      return;
    void this.loadConversation().catch((error: unknown) => this.fail(error));
  }
  private clearTiming(): void {
    this.release = undefined;
    this.observedTimes.clear();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }
  setPalette(name: PaletteName): void {
    this.localPalette = true;
    this.palette = name;
    this.changed();
  }
  private async loadSettings(): Promise<void> {
    const reply = await this.source.request({ method: "query", input: { kind: "config" } });
    if (
      !this.alive ||
      reply.status !== "ok" ||
      reply.response.method !== "query" ||
      reply.response.result.kind !== "config" ||
      !reply.response.result.config
    )
      return;
    const config = reply.response.result.config;
    this.mode = config.mode;
    if (this.motion !== config.ui.motion && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
    this.motion = config.ui.motion;
    this.updateTicker();
    if (!this.localPalette) this.palette = config.ui.palette;
    Object.assign(this.keys, config.ui.keys);
    this.changed();
  }
  async showDefinition(name: string): Promise<void> {
    const reply = await this.source.request({ method: "query", input: { kind: "definitions" } });
    if (reply.status === "error") {
      this.notice = reply.error.message;
      this.changed();
      return;
    }
    if (reply.response.method !== "query" || reply.response.result.kind !== "definitions") return;
    const definition = reply.response.result.definitions.find(
      (entry) => entry.definition.name === name,
    );
    if (!definition) {
      this.notice = `No definition named ${name}`;
      this.changed();
      return;
    }
    this.definition = definition;
    this.definitionScroll = 0;
    this.selected = undefined;
    this.screen = "conversation";
    this.generation++;
    this.changed();
  }
  get draft(): string {
    return this.selected ? (this.drafts.get(this.selected.worker) ?? "") : "";
  }
  setDraft(text: string): void {
    if (text !== this.draft && this.noticeTone === "success") this.notice = "";
    if (this.selected) this.drafts.set(this.selected.worker, text);
    this.changed();
  }
  clearDraft(worker: string, expected: string): void {
    if (this.drafts.get(worker) !== expected) return;
    this.drafts.set(worker, "");
    this.changed();
  }
  conversation(ref = this.selected): ConversationView {
    if (!ref) return { loading: false, scroll: 0 };
    const key = assignmentKey(ref);
    let view = this.conversations.get(key);
    if (!view) {
      view = { loading: false, scroll: 0, follow: true };
      this.conversations.set(key, view);
    }
    return view;
  }
  preview(ref = this.selected): PreviewView {
    if (!ref) return { loading: false };
    const key = assignmentKey(ref);
    let view = this.previews.get(key);
    if (!view) {
      view = { loading: false };
      if (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value ?? "");
      this.previews.set(key, view);
    }
    return view;
  }
  setInspectorVisible(visible: boolean): void {
    if (this.inspectorVisible === visible) return;
    this.inspectorVisible = visible;
    if (visible) this.schedulePreview();
    else this.cancelPreview();
  }
  private cancelPreview(): void {
    this.previewGeneration++;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = undefined;
    this.previewRequest?.abort();
    this.previewRequest = undefined;
    for (const view of this.previews.values()) view.loading = false;
  }
  private schedulePreview(): void {
    if (
      !this.alive ||
      this.screen !== "fleet" ||
      !this.inspectorVisible ||
      !this.selected ||
      !this.connectionAvailable ||
      this.help ||
      this.actions ||
      this.previewTimer ||
      this.previewRequest
    )
      return;
    const assignment = this.state.assignments[assignmentKey(this.selected)];
    if (!assignment || assignment.execution.phase === "queued") return;
    const view = this.preview();
    if (
      (view.result || view.error) &&
      view.revision === this.state.revision &&
      (!this.source.capabilities.live || assignment.execution.phase === "ended")
    )
      return;
    const delay =
      assignment.execution.phase === "ended"
        ? 75
        : Math.max(75, 1000 - (this.now() - this.lastPreviewRead));
    this.previewTimer = setTimeout(() => {
      this.previewTimer = undefined;
      void this.loadPreview();
    }, delay);
    this.previewTimer.unref();
  }
  async loadPreview(): Promise<void> {
    const ref = this.selected;
    if (
      !ref ||
      !this.alive ||
      this.screen !== "fleet" ||
      !this.inspectorVisible ||
      !this.connectionAvailable ||
      this.previewRequest
    )
      return;
    const view = this.preview(ref);
    const generation = this.previewGeneration;
    const revision = this.state.revision;
    const request = new AbortController();
    this.previewRequest = request;
    view.loading = true;
    this.lastPreviewRead = this.now();
    this.changed();
    try {
      const reply = await this.source.request(
        { method: "query", input: { kind: "conversation_preview", ref } },
        request.signal,
      );
      if (
        !this.alive ||
        generation !== this.previewGeneration ||
        !this.selected ||
        assignmentKey(this.selected) !== assignmentKey(ref)
      )
        return;
      view.revision = revision;
      if (reply.status === "error") {
        view.error = reply.error.message;
        return;
      }
      const parsed =
        reply.response.method === "query"
          ? conversationPreviewSchema.safeParse(reply.response.result)
          : undefined;
      if (!parsed?.success || assignmentKey(parsed.data.ref) !== assignmentKey(ref)) {
        view.error = "Source returned an incompatible conversation preview";
        return;
      }
      view.result = parsed.data;
      view.error = undefined;
    } catch (error) {
      if (generation === this.previewGeneration) {
        view.error = surfaceError(error).message;
        view.revision = revision;
      }
    } finally {
      if (this.previewRequest === request) this.previewRequest = undefined;
      if (generation === this.previewGeneration) view.loading = false;
      this.changed();
    }
  }
  scroll(lines: number): void {
    if (this.screen === "conversation" && this.definition && !this.selected) {
      this.definitionScroll = Math.max(0, this.definitionScroll + lines);
      this.changed();
      return;
    }
    if (this.screen === "fleet") {
      if (this.inspectorFocus)
        this.inspectorScroll = Math.max(
          0,
          Math.min(this.inspectorMaxScroll, this.inspectorScroll + lines),
        );
      else this.fleetScroll = Math.max(0, this.fleetScroll + lines);
      this.changed();
      return;
    }
    const view = this.conversation();
    const next = Math.min(view.maxScroll ?? Infinity, Math.max(0, view.scroll + lines));
    const atBottom = view.maxScroll !== undefined && next >= view.maxScroll;
    const resume = !view.follow && lines > 0 && atBottom;
    if (next === view.scroll && !resume) return;
    view.follow = atBottom;
    view.scroll = next;
    if (resume) {
      view.newOutput = false;
      void this.loadConversation().catch((error: unknown) => this.fail(error));
    }
    this.changed();
  }
  async loadConversation(more = false): Promise<void> {
    const ref = this.selected;
    if (!ref || !this.alive) return;
    const view = this.conversation(ref);
    if (view.loading) {
      if (!more) view.refreshPending = true;
      return;
    }
    if (more && (!view.page?.cursor || view.page.complete)) return;
    const generation = this.generation;
    const key = assignmentKey(ref);
    view.loading = true;
    this.lastConversationRead = this.now();
    view.refreshPending = false;
    this.changed();
    try {
      // Keep the displayed transcript stable while collecting immutable pages.
      let cursor = more ? view.page?.cursor : undefined;
      const entries = more ? [...(view.page?.entries ?? [])] : [];
      let page: ConversationQueryResult;
      do {
        const reply = await this.source.request({
          method: "query",
          input: { kind: "conversation", ref, ...(cursor ? { cursor } : {}) },
        });
        if (
          !this.alive ||
          this.generation !== generation ||
          !this.selected ||
          assignmentKey(this.selected) !== key
        )
          return;
        if (reply.status === "error") {
          view.error = reply.error.message;
          return;
        }
        if (reply.response.method !== "query" || reply.response.result.kind !== "conversation") {
          view.error = "Source returned an incompatible conversation";
          return;
        }
        page = reply.response.result;
        if (assignmentKey(page.ref) !== key) {
          view.error = "Source returned a conversation for a different assignment";
          return;
        }
        if (!more && view.page && !view.follow) {
          view.error = undefined;
          if (page.artifact?.digest !== view.page.artifact?.digest) view.newOutput = true;
          return;
        }
        for (const entry of page.entries) entries.push(entry);
        cursor = page.cursor;
      } while (view.follow && !page.complete && cursor);
      view.page = { ...page, entries };
      if (view.follow) view.newOutput = false;
      view.error = undefined;
    } catch (error) {
      if (this.generation === generation) view.error = surfaceError(error).message;
    } finally {
      view.loading = false;
      this.changed();
      if (view.refreshPending && this.alive && this.generation === generation) {
        view.refreshPending = false;
        void this.loadConversation().catch((error: unknown) => this.fail(error));
      }
      if (
        this.alive &&
        this.generation !== generation &&
        this.screen === "conversation" &&
        this.selected &&
        assignmentKey(this.selected) === key
      )
        void this.loadConversation().catch((error: unknown) => this.fail(error));
    }
  }

  async refresh(): Promise<void> {
    if (!this.source.capabilities.live && this.source.reconnect) {
      await this.reconnect();
      return;
    }
    this.state = indexSnapshot(this.source.snapshot().snapshot);
    if (this.screen === "conversation" && this.selected) await this.loadConversation();
    if (this.screen === "fleet") await this.loadPreview();
    else this.refreshView();
  }

  async reconnect(): Promise<void> {
    if (!this.source.reconnect) {
      this.notice =
        "This saved source has no live attachment. Open the owning runtime to reconnect";
      this.changed();
      return;
    }
    try {
      await this.source.reconnect();
      this.state = indexSnapshot(this.source.snapshot().snapshot);
      await this.loadConversation();
    } catch (error) {
      this.fail(error);
    }
  }

  private unavailable(message: string): SurfaceReply {
    this.notice = message;
    this.changed();
    return { status: "error", error: { code: "conflict", message } };
  }
  async submit(action: MessageAction = "steer"): Promise<SurfaceReply> {
    const ref = this.selected;
    const text = this.draft;
    if (!ref || !text.trim()) return this.unavailable("Select an assignment and enter a message");
    if (!this.source.capabilities.control)
      return this.unavailable("This source is read-only; attach to the owning runtime for control");
    let pending = this.messages.get(ref.worker);
    if (
      pending &&
      (pending.text !== text ||
        pending.action !== action ||
        assignmentKey(pending.ref) !== assignmentKey(ref))
    )
      return this.unavailable(
        "A previous message has an uncertain receipt. Restore its draft and retry before sending a different message",
      );
    if (!pending) {
      const target =
        action === "steer"
          ? steerTarget(this.state, ref.worker)
          : { ...ref, assignment: this.state.latest[ref.worker] };
      if (!target || assignmentKey(target) !== assignmentKey(ref))
        return this.unavailable(
          "The visible assignment is not the current control target. Select its active or latest assignment; your draft is retained",
        );
      const id = randomUUID();
      pending = {
        text,
        action,
        ref,
        envelope: commandEnvelopeSchema.parse({
          requestId: `ui/${id}`,
          expectedRevision: this.state.revision,
          command: {
            kind: action,
            worker: ref.worker,
            messageId: `ui/message/${id}`,
            text,
            ...(action === "follow_up" ? { after: [] } : {}),
          },
        }),
      };
      this.messages.set(ref.worker, pending);
    }
    const reply = await this.source.request({ method: "execute", input: pending.envelope });
    if (
      reply.status === "ok" &&
      reply.response.method === "execute" &&
      reply.response.result.status === "accepted"
    ) {
      this.messages.delete(ref.worker);
      if (this.drafts.get(ref.worker) === text) this.drafts.set(ref.worker, "");
      const receipt = reply.response.result;
      const target = receipt.assignments[0];
      const messageId =
        "messageId" in pending.envelope.command ? pending.envelope.command.messageId : undefined;
      this.options.accepted?.(receipt, messageId);
      if (
        target &&
        action !== "steer" &&
        this.selected &&
        assignmentKey(this.selected) === assignmentKey(ref)
      )
        this.navigate(this.screen, target);
      if (this.selected?.worker === ref.worker) {
        this.notice = `Message queued for ${target?.worker ?? ref.worker}`;
        this.noticeTone = "success";
      }
    } else {
      const error =
        reply.status === "error"
          ? reply.error
          : reply.response.method === "execute" && reply.response.result.status === "rejected"
            ? reply.response.result.error
            : undefined;
      this.notice = error?.message ?? "Source did not return a command receipt";
      if (error && !["commit_unknown", "transport_closed", "internal_error"].includes(error.code))
        this.messages.delete(ref.worker);
    }
    this.changed();
    return reply;
  }
  async inspectPatch(): Promise<void> {
    const ref = this.selected;
    if (!ref) return;
    const result = this.state.results[assignmentKey(ref)]?.result;
    if (!result) return;
    const view = this.conversation();
    view.worktreePatch = undefined;
    view.inspection = undefined;
    if (result.snapshot) {
      await this.control("changes");
      return;
    }
    const worktree = result.worktree;
    if (!worktree) {
      this.notice = "No worktree evidence available";
      this.changed();
      return;
    }
    if (!this.source.inspectWorktree) {
      view.worktreePatch = `Open the worktree at ${worktree.path}
Run git diff ${worktree.base} and git status --short to inspect current files.`;
      this.changed();
      return;
    }
    this.patchRequest?.abort();
    const request = new AbortController();
    this.patchRequest = request;
    this.notice = "Reading current worktree patch…";
    this.changed();
    try {
      const patch = await this.source.inspectWorktree(ref, request.signal);
      if (!request.signal.aborted) {
        view.worktreePatch = patch;
        this.notice = "";
      }
    } catch (error) {
      if (!request.signal.aborted) this.fail(error);
    } finally {
      if (this.patchRequest === request) this.patchRequest = undefined;
      this.changed();
    }
  }
  async control(
    kind: "cancel" | "background" | "recover" | "inspect" | "changes",
    scope: "assignment" | "worker" | "run" = "worker",
  ): Promise<SurfaceReply> {
    const ref = this.selected;
    if (!ref && kind !== "background" && !(kind === "cancel" && scope === "run"))
      return this.unavailable("Select an assignment first");
    if (kind !== "inspect" && kind !== "changes" && !this.source.capabilities.control)
      return this.unavailable("This source is read-only; control requires the owning runtime");
    if (kind === "recover" && !this.source.capabilities.recover)
      return this.unavailable("Recovery is unavailable from this source");
    const call =
      kind === "inspect" || kind === "changes"
        ? { method: "query", input: { kind: kind === "inspect" ? "result" : "changes", ref } }
        : kind === "recover"
          ? { method: "recover", input: { targets: [ref] } }
          : {
              method: "execute",
              input: {
                requestId: randomUUID(),
                // The explicit target/scope fixes intent. New observations must
                // not invalidate a stop or release of the foreground wait.
                command:
                  kind === "background"
                    ? { kind }
                    : {
                        kind,
                        scope,
                        ...(scope !== "run" && ref ? { worker: ref.worker } : {}),
                        ...(scope === "assignment" && ref ? { assignment: ref.assignment } : {}),
                      },
              },
            };
    const reply = await this.source.request(call);
    if (reply.status === "error") this.notice = reply.error.message;
    else if (reply.response.method === "query") {
      if (!ref || !this.selected || assignmentKey(ref) !== assignmentKey(this.selected))
        return reply;
      this.conversation().inspection = reply.response.result;
      this.notice =
        kind === "changes" ? "Retained workspace changes" : "Retained assignment result";
    } else if (reply.response.method === "execute") {
      const receipt = reply.response.result;
      if (receipt.status !== "accepted") this.notice = receipt.error.message;
      else if (kind === "background") this.notice = "Foreground wait released; agents keep working";
      else {
        const target = {
          assignment: `${ref?.worker}/${ref?.assignment}`,
          worker: `agent ${ref?.worker}`,
          run: "the entire fleet",
        }[scope];
        this.notice = `Stop requested for ${target}; cleanup may take time`;
      }
      if (receipt.status === "accepted") this.options.accepted?.(receipt);
    } else this.notice = JSON.stringify(reply.response.result);
    this.changed();
    return reply;
  }
  async replace(worker: string, task: string): Promise<SurfaceReply> {
    const selected = this.selected ? this.state.workers[this.selected.worker] : undefined;
    if (!selected || !this.source.capabilities.control)
      return this.unavailable(
        "Select a worker in a controllable runtime before creating a replacement",
      );
    const reply = await this.source.request({
      method: "execute",
      input: {
        requestId: randomUUID(),
        expectedRevision: this.state.revision,
        command: {
          kind: "add",
          workers: [
            {
              id: worker,
              agent: selected.agent,
              task,
              origin: this.selected,
              workspace: selected.workspace,
              backend: selected.backend,
              lifetime: selected.lifetime,
            },
          ],
        },
      },
    });
    if (
      reply.status === "ok" &&
      reply.response.method === "execute" &&
      reply.response.result.status === "accepted"
    ) {
      this.options.accepted?.(reply.response.result);
      this.navigate("conversation", reply.response.result.assignments[0]);
    } else
      this.notice =
        reply.status === "error"
          ? reply.error.message
          : "Replacement was not accepted; inspect its receipt";
    this.changed();
    return reply;
  }
  dispose(): void {
    this.patchRequest?.abort();
    if (!this.alive) return;
    this.alive = false;
    this.cancelPreview();
    this.generation++;
    this.unsubscribe?.();
    this.disconnect?.();
    this.clearTiming();
    this.listeners.clear();
  }
}
