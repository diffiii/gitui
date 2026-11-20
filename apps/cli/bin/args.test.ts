import { expect, test } from "bun:test";
import { DEFAULT_PORT } from "@gitui/shared";
import { ArgsError, type Options, parseArgs } from "./args.ts";

const defaults: Options = {
  port: DEFAULT_PORT,
  open: true,
  mode: { kind: "hosted", origins: [] },
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

test("--local and --allow-origin, in either order, keep the origins", () => {
  const origins = ["http://localhost:5173", "https://x.example"];
  const local: Options = { ...defaults, mode: { kind: "local", origins } };
  expect(
    parseArgs(["--allow-origin", origins[0], "--local", "--allow-origin", origins[1]]),
  ).toEqual(local);
  expect(
    parseArgs(["--local", "--allow-origin", origins[0], "--allow-origin", origins[1]]),
  ).toEqual(local);
  expect(parseArgs(["--allow-origin", origins[0]])).toEqual({
    ...defaults,
    mode: { kind: "hosted", origins: [origins[0]] },
  });
});

test("--allow-origin needs exactly an origin", () => {
  for (const argv of [["--allow-origin"], ["--allow-origin", "http://x.example/path"]]) {
    expect(refusal(argv)).toStartWith("--allow-origin needs an origin");
  }
});

test("--lan alone picks an address; with an IPv4 address it uses that", () => {
  expect(parseArgs(["--lan"])).toEqual({ ...defaults, mode: { kind: "lan", address: null } });
  expect(parseArgs(["--lan", "192.168.1.5"])).toEqual({
    ...defaults,
    mode: { kind: "lan", address: "192.168.1.5" },
  });
});

test("--lan followed by a repository path or an option takes no address", () => {
  expect(parseArgs(["--lan", "~/code/x"])).toEqual({
    ...defaults,
    mode: { kind: "lan", address: null },
    target: "~/code/x",
  });
  expect(parseArgs(["--lan", "-p", "5000"])).toEqual({
    ...defaults,
    port: 5000,
    mode: { kind: "lan", address: null },
  });
});

test("--lan refuses what looks like an address but isn't an IPv4 one of this machine", () => {
  expect(refusal(["--lan", "0.0.0.0"])).toBe("--lan needs this machine's address, not 0.0.0.0");
  for (const address of ["::1", "fe80::1", "192.168.1", "10.0.0.0.1"]) {
    expect(refusal(["--lan", address])).toBe(
      `--lan takes an IPv4 address of this machine, not ${address}`,
    );
  }
});

test("a dotted-number repository path is a path, unless it directly follows --lan", () => {
  expect(parseArgs(["192.168.1"])).toEqual({ ...defaults, target: "192.168.1" });
  expect(parseArgs(["--lan", "./192.168.1"])).toEqual({
    ...defaults,
    mode: { kind: "lan", address: null },
    target: "./192.168.1",
  });
  expect(parseArgs(["192.168.1", "--lan"])).toEqual({
    ...defaults,
    mode: { kind: "lan", address: null },
    target: "192.168.1",
  });
});

test("--lan is given at most once", () => {
  for (const argv of [
    ["--lan", "--lan"],
    ["--lan", "192.168.1.5", "--lan"],
    ["--lan", "--lan", "192.168.1.5"],
  ]) {
    expect(refusal(argv)).toBe("--lan is given twice");
  }
});

test("--local and --lan can't be combined, in either order", () => {
  for (const argv of [
    ["--local", "--lan"],
    ["--lan", "--local"],
    ["--lan", "192.168.1.5", "--local"],
  ]) {
    expect(refusal(argv)).toBe("--local and --lan can't be combined");
  }
});

test("--allow-origin and --lan can't be combined, in either order", () => {
  for (const argv of [
    ["--allow-origin", "http://localhost:5173", "--lan"],
    ["--lan", "--allow-origin", "http://localhost:5173"],
  ]) {
    expect(refusal(argv)).toBe(
      "--allow-origin doesn't apply to --lan, which serves its own UI only",
    );
  }
});
