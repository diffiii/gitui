// Error messages for Effect Schemas that say exactly what is wrong, in our words: the API's
// request schemas (app.ts) decode with these, and their messages are the 400s' errors. A schema
// built with `withMessage` fails with its message for a wrong type, a failed check or a missing
// key; `issueMessage` reads the message back from the issue.
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import type * as SchemaIssue from "effect/SchemaIssue";

/**
 * `schema`, failing with `message` when its value has the wrong type or its key is missing,
 * and then `checks`, which carry their own messages. (Annotating a schema that has checks
 * annotates its last check instead, hence the order.)
 */
export function withMessage<S extends Schema.Top>(
  schema: S,
  message: string,
  ...checks: [] | [SchemaAST.Check<S["Type"]>, ...SchemaAST.Check<S["Type"]>[]]
): S["Rebuild"] {
  const annotated = schema.annotate({ message });
  const checked =
    checks.length === 0 ? annotated : annotated.check(...(checks as [SchemaAST.Check<S["Type"]>]));
  return checked.annotateKey({ messageMissingKey: message });
}

/**
 * What an issue says is wrong: the `message` of the deepest schema, check or missing key on the
 * first failure that has one, or undefined if none does (a union none of whose members' tags
 * match, unless it has a message of its own).
 */
export function issueMessage(issue: SchemaIssue.Issue): string | undefined {
  switch (issue._tag) {
    case "Pointer":
    case "Encoding":
      return issueMessage(issue.issue);
    case "Filter":
      return issueMessage(issue.issue) ?? issue.filter.annotations?.message;
    case "Composite":
    case "AnyOf":
      for (const inner of issue.issues) {
        const found = issueMessage(inner);
        if (found !== undefined) return found;
      }
      return issue.ast.annotations?.message as string | undefined;
    case "MissingKey":
      return issue.annotations?.messageMissingKey;
    case "InvalidType":
    case "OneOf":
      return issue.ast.annotations?.message as string | undefined;
    case "InvalidValue":
    case "Forbidden":
      return issue.annotations?.message as string | undefined;
    case "UnexpectedKey":
      return undefined;
  }
}
