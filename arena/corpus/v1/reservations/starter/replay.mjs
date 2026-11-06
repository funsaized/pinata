import { loadStock } from "./catalog.mjs";
import { reserve } from "./reservation.mjs";

export function fulfill(stockEntries, _orders) {
  const stock = loadStock(stockEntries);
  void reserve;
  throw new Error(`Integrate fulfill; loaded ${Object.keys(stock).length} SKUs`);
}
