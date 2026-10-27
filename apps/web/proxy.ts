import { NextResponse, type NextRequest } from "next/server";

/** The whole app sits behind one password (spec 3.4): HTTP Basic, any user name. */
export function proxy(req: NextRequest) {
  const password = process.env.APP_PASSWORD ?? "";
  if (!password) {
    if (process.env.ALLOW_NO_PASSWORD === "1") return NextResponse.next();
    return new NextResponse("APP_PASSWORD is not set on the server.", { status: 503 });
  }
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const given = decoded.slice(decoded.indexOf(":") + 1);
      if (given.length === password.length && [...given].every((c, i) => c === password[i])) return NextResponse.next();
    } catch {
      /* fall through */
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Script-to-Video Studio", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
