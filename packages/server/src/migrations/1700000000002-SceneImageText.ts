import type { MigrationInterface, QueryRunner } from "typeorm";

/** Words a scene's picture must show inside it (up to 3 short labels). Empty array = no text in the picture. */
export class SceneImageText1700000000002 implements MigrationInterface {
  name = "SceneImageText1700000000002";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "scenes" ADD COLUMN IF NOT EXISTS "imageText" jsonb NOT NULL DEFAULT '[]'`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "scenes" DROP COLUMN IF EXISTS "imageText"`);
  }
}
