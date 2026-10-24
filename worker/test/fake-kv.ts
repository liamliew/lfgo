// In-memory stand-in for the KV binding methods the Worker uses.
// Follows the documented shapes: list() -> {keys:[{name,metadata}], list_complete, cursor}.
export class FakeKV {
  store = new Map<string, { value: string; metadata?: unknown }>();
  async get(key: string) {
    return this.store.get(key)?.value ?? null;
  }
  async put(key: string, value: string, opts?: { metadata?: unknown }) {
    if (new TextEncoder().encode(JSON.stringify(opts?.metadata ?? null)).length > 1024) {
      throw new Error("KV PUT failed: 400 Metadata too large");
    }
    this.store.set(key, { value, metadata: opts?.metadata });
  }
  async delete(key: string) {
    this.store.delete(key);
  }
  async list(opts: { limit?: number; cursor?: string } = {}) {
    const names = [...this.store.keys()].sort();
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const limit = opts.limit ?? 1000;
    const slice = names.slice(start, start + limit);
    const done = start + limit >= names.length;
    return {
      keys: slice.map((name) => ({ name, metadata: this.store.get(name)!.metadata })),
      list_complete: done,
      cursor: done ? undefined : String(start + limit),
    };
  }
}
