import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Character patch: which people appear in each scene (hair, outfit, props, expression, pose).
 * Nullable on purpose: scenes planned before this column existed stay NULL and keep the old
 * behaviour (character sheet attached); new plans always write an array ([] = no people).
 */
export class SceneCharacters1700000000001 implements MigrationInterface {
  name = "SceneCharacters1700000000001";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "scenes" ADD COLUMN IF NOT EXISTS "characters" jsonb`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "scenes" DROP COLUMN IF EXISTS "characters"`);
  }
}
