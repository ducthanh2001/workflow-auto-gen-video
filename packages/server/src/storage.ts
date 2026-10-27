/** StorageService (spec 3.3): local disk now, S3-compatible later. Assets are addressed by id, never by user paths. */
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

export interface StorageService {
  /** absolute path for a storage key; throws if the key escapes the root */
  resolve(key: string): string;
  put(key: string, data: Buffer): Promise<number>;
  putFile(key: string, srcPath: string): Promise<number>;
  read(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  size(key: string): Promise<number>;
  stream(key: string, range?: { start: number; end: number }): NodeJS.ReadableStream;
  remove(key: string): Promise<void>;
  removeDir(prefix: string): Promise<void>;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

export class LocalDiskStorage implements StorageService {
  private readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  resolve(key: string): string {
    const parts = key.split("/");
    if (!parts.length || parts.some((p) => !SEGMENT.test(p) || p === "." || p === "..")) {
      throw new Error(`invalid storage key: ${key}`);
    }
    const full = path.resolve(this.root, ...parts);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error(`storage key escapes root: ${key}`);
    return full;
  }

  async put(key: string, data: Buffer): Promise<number> {
    const f = this.resolve(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, data);
    return data.length;
  }

  async putFile(key: string, srcPath: string): Promise<number> {
    const f = this.resolve(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    if (path.resolve(srcPath) !== f) await fs.copyFile(srcPath, f);
    return (await fs.stat(f)).size;
  }

  read(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async size(key: string): Promise<number> {
    return (await fs.stat(this.resolve(key))).size;
  }

  stream(key: string, range?: { start: number; end: number }) {
    return createReadStream(this.resolve(key), range);
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async removeDir(prefix: string): Promise<void> {
    await fs.rm(this.resolve(prefix), { recursive: true, force: true });
  }
}

export const projectKey = (projectId: string, ...parts: string[]) => ["projects", projectId, ...parts].join("/");
