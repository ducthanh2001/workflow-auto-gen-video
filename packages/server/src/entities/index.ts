import "reflect-metadata";
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import type {
  AssetType, Camera, Lighting, Motion, ProjectSettings, ProjectState, SceneCharacter, Shot, Stage, TransitionOut,
} from "@vp/shared";

const num = {
  to: (v?: number | null) => v,
  from: (v?: string | null) => (v === null || v === undefined ? v : Number(v)),
};

@Entity("projects")
export class Project {
  @PrimaryGeneratedColumn("uuid") id!: string;

  @Index({ unique: true })
  @Column({ type: "varchar", length: 200 })
  slug!: string;

  @Column({ type: "varchar", length: 300 }) title!: string;

  @Column({ type: "varchar", length: 40, default: "created" }) status!: ProjectState;

  @Column({ type: "jsonb" }) settings!: ProjectSettings;

  @Column({ type: "text" }) scriptRaw!: string;

  /** parsed front matter, beats, word count and warnings */
  @Column({ type: "jsonb", default: () => "'{}'" }) meta!: {
    sources?: string[];
    voice?: string;
    style?: string;
    wordCount?: number;
    beats?: string[];
    warnings?: string[];
    planWarnings?: string[];
    narration?: string;
    refsGen?: number;
    /** the modern-outfit hero sheet (shirt, hoodie, jacket, suit); the ancient one is characterSheetAssetId */
    characterSheetModernAssetId?: string | null;
    /** CHARACTER_LOCK_VERSION in force when the references were made (shared-lock styles only) */
    characterLockVersion?: number;
    thumbGen?: number;
    clipFallbacks?: number[];
  };

  /** stop target of the current `run`; null when idle */
  @Column({ type: "varchar", length: 40, nullable: true }) runTo!: ProjectState | null;

  @Column({ type: "uuid", nullable: true }) characterSheetAssetId!: string | null;
  @Column({ type: "uuid", nullable: true }) styleAnchorAssetId!: string | null;

  /** downstream outputs that are out of date (e.g. ["draft","final"]) */
  @Column({ type: "jsonb", default: () => "'[]'" }) stale!: string[];

  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
}

@Entity("scenes")
@Index(["projectId", "idx"], { unique: true })
export class Scene {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Index() @Column({ type: "uuid" }) projectId!: string;
  @Column({ type: "int" }) idx!: number;
  @Column({ type: "varchar", length: 300 }) beat!: string;
  /** immutable after planning */
  @Column({ type: "text" }) narration!: string;
  @Column({ type: "text" }) visual!: string;
  /** people in the scene; null = planned before characters existed (treated as "shows the main character") */
  @Column({ type: "jsonb", nullable: true }) characters!: SceneCharacter[] | null;
  /** short words the picture itself shows; [] = no text in the picture */
  @Column({ type: "jsonb", default: () => "'[]'" }) imageText!: string[];
  /** light and time of day (Scene Style Lock): picks the palette sentence of the image prompt */
  @Column({ type: "varchar", length: 20, default: "golden_hour" }) lighting!: Lighting;
  @Column({ type: "varchar", length: 20 }) shot!: Shot;
  @Column({ type: "varchar", length: 20 }) camera!: Camera;
  @Column({ type: "varchar", length: 20 }) motion!: Motion;
  @Column({ type: "varchar", length: 20 }) transitionOut!: TransitionOut;
  @Column({ type: "varchar", length: 40, nullable: true }) onScreenText!: string | null;
  @Column({ type: "boolean", default: false }) approved!: boolean;
  /** ready | failed | pending */
  @Column({ type: "varchar", length: 20, default: "pending" }) status!: "pending" | "ready" | "failed";
  @Column({ type: "text", nullable: true }) error!: string | null;
  @Column({ type: "uuid", nullable: true }) audioAssetId!: string | null;
  @Column({ type: "uuid", nullable: true }) imageAssetId!: string | null;
  @Column({ type: "uuid", nullable: true }) clipAssetId!: string | null;
  @Column({ type: "float", nullable: true }) audioDurationSec!: number | null;
  @Column({ type: "float", nullable: true }) slotSec!: number | null;
  /** bumped on regenerate so the cache key changes and the provider is called again */
  @Column({ type: "jsonb", default: () => "'{}'" }) gen!: { voice?: number; image?: number; clip?: number };
  /** per-stage errors so one failure does not hide another */
  @Column({ type: "jsonb", default: () => "'{}'" }) errors!: { voice?: string; image?: string; clip?: string };
}

@Entity("assets")
@Index(["projectId", "cacheKey"], { unique: true, where: '"cacheKey" IS NOT NULL' })
export class Asset {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Index() @Column({ type: "uuid" }) projectId!: string;
  @Column({ type: "uuid", nullable: true }) sceneId!: string | null;
  @Column({ type: "varchar", length: 20 }) type!: AssetType;
  @Column({ type: "varchar", length: 500 }) storageKey!: string;
  @Column({ type: "varchar", length: 80, nullable: true }) mime!: string | null;
  @Column({ type: "varchar", length: 60, nullable: true }) provider!: string | null;
  @Column({ type: "varchar", length: 120, nullable: true }) model!: string | null;
  @Column({ type: "jsonb", default: () => "'{}'" }) params!: Record<string, unknown>;
  @Column({ type: "varchar", length: 64, nullable: true }) cacheKey!: string | null;
  @Column({ type: "numeric", precision: 12, scale: 4, default: 0, transformer: num }) costUsd!: number;
  @Column({ type: "float", nullable: true }) durationSec!: number | null;
  @Column({ type: "bigint", default: 0, transformer: num }) bytes!: number;
  @Column({ type: "boolean", default: false }) stale!: boolean;
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
}

@Entity("jobs")
export class Job {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Index() @Column({ type: "uuid" }) projectId!: string;
  @Column({ type: "uuid", nullable: true }) sceneId!: string | null;
  @Column({ type: "varchar", length: 20 }) stage!: Stage;
  @Column({ type: "varchar", length: 20, default: "queued" }) status!: "queued" | "running" | "succeeded" | "failed";
  @Column({ type: "int", default: 0 }) attempts!: number;
  @Column({ type: "text", nullable: true }) error!: string | null;
  @Column({ type: "numeric", precision: 12, scale: 4, default: 0, transformer: num }) costUsd!: number;
  @Column({ type: "timestamptz", nullable: true }) startedAt!: Date | null;
  @Column({ type: "timestamptz", nullable: true }) finishedAt!: Date | null;
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
}

@Entity("music_tracks")
export class MusicTrack {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ type: "varchar", length: 200 }) name!: string;
  @Column({ type: "varchar", length: 500 }) storageKey!: string;
  @Column({ type: "float" }) durationSec!: number;
  /** required, non-empty (spec 4) */
  @Column({ type: "text" }) licenseNote!: string;
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
}

export const ENTITIES = [Project, Scene, Asset, Job, MusicTrack];
