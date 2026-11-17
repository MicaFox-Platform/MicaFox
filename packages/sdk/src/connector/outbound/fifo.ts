/**
 * A first-in, first-out queue with O(1) amortized `push` and `shift`. Taken items are skipped by a head index instead
 * of `Array.prototype.shift()`, which moves every remaining item; the array is compacted once the head passes half of
 * it, so each item is copied O(1) times on average and the array never holds more than twice the queue.
 */
export class Fifo<T> {
  private items: T[] = [];
  private head = 0;

  /** Items in the queue. */
  get size(): number {
    return this.items.length - this.head;
  }

  /** Adds `item` at the end. */
  push(item: T): void {
    this.items.push(item);
  }

  /** Removes and returns the first item; `undefined` when the queue is empty. */
  shift(): T | undefined {
    if (this.head === this.items.length) {
      return undefined;
    }

    const item = this.items[this.head];
    this.head += 1;
    if (this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }

    return item;
  }

  /** The items from first to last, without removing them. */
  *[Symbol.iterator](): Generator<T> {
    for (let index = this.head; index < this.items.length; index += 1) {
      // Within bounds: `index` runs from the head to the end
      yield this.items[index] as T;
    }
  }
}
