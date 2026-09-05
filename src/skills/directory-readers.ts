import { resolve } from "node:path";
import { withPackageDirectory, type PackageDirectoryReader } from "./paths.js";

type Entry = {
  count: number;
  ready: Promise<PackageDirectoryReader>;
  done: Promise<void>;
  release: () => void;
};

/** Share only an open root during overlapping reads, never bytes or authorization. */
export class DirectoryReaders {
  private entries = new Map<string, Entry>();
  async withDirectory<T>(
    root: string,
    read: (reader: PackageDirectoryReader) => Promise<T>,
  ): Promise<T> {
    root = resolve(root);
    let entry = this.entries.get(root);
    if (!entry) {
      const ready = Promise.withResolvers<PackageDirectoryReader>();
      const release = Promise.withResolvers<void>();
      const done = withPackageDirectory(root, async (reader) => {
        ready.resolve(reader);
        await release.promise;
      });
      // Attach before returning to the caller: an open failure rejects ready as well.
      void done.catch(ready.reject);
      entry = {
        count: 0,
        ready: ready.promise,
        done,
        release: release.resolve,
      };
      this.entries.set(root, entry);
    }
    entry.count++;
    try {
      return await read(await entry.ready);
    } finally {
      entry.count--;
      if (entry.count === 0) {
        this.entries.delete(root);
        entry.release();
        await entry.done;
      }
    }
  }
}
