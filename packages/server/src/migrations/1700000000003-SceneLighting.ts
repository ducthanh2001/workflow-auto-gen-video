import type { MigrationInterface, QueryRunner } from "typeorm";

/** Light and time of day of a scene (Scene Style Lock): picks the palette sentence of its image prompt. */
export class SceneLighting1700000000003 implements MigrationInterface {
  name = "SceneLighting1700000000003";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "scenes" ADD COLUMN IF NOT EXISTS "lighting" varchar(20) NOT NULL DEFAULT 'golden_hour'`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "scenes" DROP COLUMN IF EXISTS "lighting"`);
  }
}
