import "reflect-metadata";
import { DataSource } from "typeorm";
import { ENTITIES } from "./entities";
import { Init1700000000000 } from "./migrations/1700000000000-Init";
import { SceneCharacters1700000000001 } from "./migrations/1700000000001-SceneCharacters";
import { SceneImageText1700000000002 } from "./migrations/1700000000002-SceneImageText";
import { SceneLighting1700000000003 } from "./migrations/1700000000003-SceneLighting";

export const MIGRATIONS = [Init1700000000000, SceneCharacters1700000000001, SceneImageText1700000000002, SceneLighting1700000000003];

/** `synchronize` is always off (spec 4): schema changes go through migrations. */
export function createDataSource(url: string): DataSource {
  return new DataSource({
    type: "postgres",
    url,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    synchronize: false,
    logging: false,
  });
}

export async function initDb(url: string, opts: { migrate?: boolean } = {}): Promise<DataSource> {
  const ds = createDataSource(url);
  await ds.initialize();
  if (opts.migrate !== false) await ds.runMigrations();
  return ds;
}
