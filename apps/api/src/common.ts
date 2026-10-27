import {
  ArgumentsHost, BadRequestException, CanActivate, Catch, ExceptionFilter, ExecutionContext, HttpException, Inject, Injectable,
  PipeTransform, UnauthorizedException,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { ZodError, type ZodType } from "zod";
import { BudgetExceededError, ScriptError } from "@vp/core";
import { PipelineError, type Ctx } from "@vp/server";

export const CTX = Symbol("CTX");
export const PIPELINE = Symbol("PIPELINE");

/** Validate a body or param with a zod schema. */
export class ZodPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) {
      throw new BadRequestException(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    }
    return r.data;
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Whole app behind one password (spec 3.4): HTTP Basic, any user name. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(CTX) private readonly ctx: Ctx) {}

  canActivate(context: ExecutionContext): boolean {
    const password = this.ctx.cfg.appPassword;
    if (!password) {
      if (this.ctx.cfg.env.ALLOW_NO_PASSWORD === "1") return true;
      throw new UnauthorizedException("APP_PASSWORD is not set on the server");
    }
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const h = req.headers.authorization ?? "";
    if (h.startsWith("Basic ")) {
      const decoded = Buffer.from(h.slice(6), "base64").toString("utf8");
      const pw = decoded.slice(decoded.indexOf(":") + 1);
      if (safeEqual(pw, password)) return true;
    }
    res.setHeader("WWW-Authenticate", 'Basic realm="Script-to-Video Studio", charset="UTF-8"');
    throw new UnauthorizedException();
  }
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) return;
    if (err instanceof HttpException) {
      const body = err.getResponse();
      return res.status(err.getStatus()).json(typeof body === "string" ? { message: body } : body);
    }
    if (err instanceof PipelineError) return res.status(err.httpStatus).json({ message: err.message });
    if (err instanceof BudgetExceededError) {
      return res.status(402).json({ message: err.message, code: "budget_exceeded", spent: err.spent, estimate: err.estimate, cap: err.cap });
    }
    if (err instanceof ScriptError) return res.status(400).json({ message: err.message, code: "script_invalid" });
    if (err instanceof ZodError) return res.status(400).json({ message: err.message });
    // never leak internals or secrets
    console.error("unhandled error:", (err as Error)?.message);
    return res.status(500).json({ message: "internal error" });
  }
}
