import { expect, test } from "bun:test";
import { DEFAULT_PORT } from "@gitui/shared";
import { ArgsError, hostnameAsName, type Options, parseArgs } from "./args.ts";

const defaults: Options = {
  port: DEFAULT_PORT,
  open: true,
  origins: [],
  nearby: null,
  target: null,
};

/** The message `argv` is refused with. */
function refusal(argv: string[]) {
  try {
    parseArgs(argv);
  } catch (e) {
    expect(e).toBeInstanceOf(ArgsError);
    return (e as ArgsError).message;
  }
  throw new Error(`${argv.join(" ")} was accepted`);
}

test("no arguments open the hosted app with the repository picker", () => {
  expect(parseArgs([])).toEqual(defaults);
});

test("a path, -p and --no-open", () => {
  expect(parseArgs(["~/code/x", "-p", "5000", "--no-open"])).toEqual({
    ...defaults,
    port: 5000,
    open: false,
    target: "~/code/x",
  });
  expect(parseArgs(["--port", "5001"])).toMatchObject({ port: 5001 });
});

test("-p needs a port number", () => {
  for (const argv of [["-p"], ["-p", "x"], ["-p", "0"], ["-p", "65536"], ["-p", "4.5"]]) {
    expect(refusal(argv)).toStartWith("-p needs a port number");
  }
});

test("--help stops parsing where it appears", () => {
  expect(parseArgs(["--help"])).toBe("help");
  expect(parseArgs(["-p", "5000", "-h", "--bogus"])).toBe("help");
});

test("an unknown option is refused with the help", () => {
  expect(refusal(["--bogus"])).toStartWith("Unknown option --bogus\n\ngitui");
});

test("--allow-origin is repeatable", () => {
  const origins = ["http://localhost:5173", "https://x.example"];
  expect(parseArgs(["--allow-origin", origins[0], "--allow-origin", origins[1]])).toEqual({
    ...defaults,
    origins,
  });
});

test("--allow-origin needs exactly an origin", () => {
  for (const argv of [["--allow-origin"], ["--allow-origin", "http://x.example/path"]]) {
    expect(refusal(argv)).toStartWith("--allow-origin needs an origin");
  }
});

test("--nearby lists this machine, with an optional name", () => {
  expect(parseArgs(["--nearby"])).toEqual({ ...defaults, nearby: { name: null } });
  expect(parseArgs(["--name", " Desk ", "--nearby"])).toEqual({
    ...defaults,
    nearby: { name: "Desk" },
  });
});

test("--name needs --nearby and a short printable name", () => {
  expect(refusal(["--name", "Desk"])).toBe("--name only applies to --nearby");
  for (const name of [undefined, "", "  ", "a\u001b[2Jb", "evil\u202ekoob", "x".repeat(64)]) {
    const argv = name === undefined ? ["--nearby", "--name"] : ["--nearby", "--name", name];
    expect(refusal(argv)).toBe(
      "--name needs a name of 1 to 63 characters, without control or bidi characters",
    );
  }
  expect(parseArgs(["--nearby", "--name", "Jan's MacBook ✨"])).toMatchObject({
    nearby: { name: "Jan's MacBook ✨" },
  });
});

test("the default --nearby name is the hostname without .local, printable and short", () => {
  expect(hostnameAsName("Jans-MacBook-Pro.local")).toBe("Jans-MacBook-Pro");
  expect(hostnameAsName("desk")).toBe("desk");
  expect(hostnameAsName("a\u001bb")).toBe("ab");
  expect(hostnameAsName("x".repeat(100))).toHaveLength(63);
  // Cut by code point, so no emoji is split in half; bidi controls go too.
  expect(hostnameAsName("💻".repeat(100))).toBe("💻".repeat(63));
  expect(hostnameAsName("my\u202edesk")).toBe("mydesk");
  expect(hostnameAsName(".local")).toBe("gitui");
});
