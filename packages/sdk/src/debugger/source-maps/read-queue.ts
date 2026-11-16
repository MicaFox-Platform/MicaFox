/** Why a map is read: by name for an entry whose file it may hold, or for a search of the bundles. */
export type ReadNeed = "name" | "search";

// A FIFO with a head index, so taking from it copies nothing; the part taken is cut off once it is the larger half,
// so a lane that never drains holds only what is waiting
class Lane<Item> {
  private items: Item[] = [];
  private head = 0;

  push(item: Item): void {
    this.items.push(item);
  }

  take(): Item | undefined {
    const item = this.items[this.head];
    if (item === undefined) {
      this.clear();
      return undefined;
    }

    this.head += 1;
    if (this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }

    return item;
  }

  clear(): void {
    this.items = [];
    this.head = 0;
  }
}

/**
 * The reads waiting their turn, in two lanes: every read by name before any read for a search, each lane in the
 * order it was asked for. It holds at most one item per script record and need, which its owner checks.
 */
export class ReadQueue<Item> {
  private readonly byName = new Lane<Item>();
  private readonly forSearch = new Lane<Item>();

  push(need: ReadNeed, item: Item): void {
    (need === "name" ? this.byName : this.forSearch).push(item);
  }

  /** The next read: the oldest by name, else the oldest for a search; undefined when both lanes are empty. */
  take(): Item | undefined {
    return this.byName.take() ?? this.forSearch.take();
  }

  clear(): void {
    this.byName.clear();
    this.forSearch.clear();
  }
}
