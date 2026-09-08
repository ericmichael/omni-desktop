/** Origin/profile-local storage. IndexedDB structured cloning preserves File
 * bytes and metadata; attachments never go into localStorage or app settings. */
export class DraftStorage<T> {
  private database?: Promise<IDBDatabase>;
  constructor(
    private factory: IDBFactory,
    private name = 'omni-conversation-drafts-v1'
  ) {}

  private open() {
    if (this.database) {
      return this.database;
    }
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let blocked = false;
      const request = this.factory.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('drafts');
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          if (this.database === opening) {
            this.database = undefined;
          }
        };
        db.onclose = () => {
          if (this.database === opening) {
            this.database = undefined;
          }
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(new Error('Draft storage is blocked by another app window'));
      };
    });
    this.database = opening;
    void opening.catch(() => {
      if (this.database === opening) {
        this.database = undefined;
      }
    });
    return opening;
  }

  /** Broadcasts must not clone every conversation's attachment bytes. */
  async readOne(id: string): Promise<T | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', 'readonly');
      const request = tx.objectStore('drafts').get(id);
      tx.oncomplete = () => resolve(request.result as T | undefined);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  async read(): Promise<Array<[string, T]>> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', 'readonly');
      const rows: Array<[string, T]> = [];
      const request = tx.objectStore('drafts').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          rows.push([String(cursor.key), cursor.value as T]);
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve(rows);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  async write(id: string, value: T): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite');
      tx.objectStore('drafts').put(value, id);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Read/modify/write within one transaction, serialized across windows. */
  async update(id: string, change: (current: T | undefined) => T): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite');
      const store = tx.objectStore('drafts');
      const read = store.get(id);
      let value: T;
      let failure: unknown;
      read.onsuccess = () => {
        try {
          value = change(read.result as T | undefined);
          store.put(value, id);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(failure ?? tx.error);
      tx.onerror = () => reject(failure ?? tx.error);
    });
  }
}
