import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ValidationError, formatZodError } from "./errors.js";

const HttpGrant = z
  .object({
    id: z.string().min(1),
    kind: z.literal("http"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    urlPattern: z.string().min(1),
    secret: z.string().min(1),
  })
  .strict();

const GitPushGrant = z
  .object({
    id: z.string().min(1),
    kind: z.literal("git-push"),
    remote: z.string().min(1),
    branches: z.array(z.string().min(1)).min(1),
    secret: z.string().min(1),
  })
  .strict();

const ProvisionGrant = z
  .object({
    id: z.string().min(1),
    kind: z.literal("provision"),
    resource: z.enum(["github-repo", "host-site", "dns-subdomain"]),
    scope: z.string().min(1),
    limit: z.object({ perDay: z.number().int().positive() }).strict(),
    secret: z.string().min(1),
  })
  .strict();

export const GrantSchema = z.discriminatedUnion("kind", [HttpGrant, GitPushGrant, ProvisionGrant]);
export type Grant = z.infer<typeof GrantSchema>;

const GrantsFileSchema = z.object({ grants: z.array(GrantSchema).default([]) }).strict();

export function parseGrants(source: string, yamlText: string): Grant[] {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText) ?? {};
  } catch (error) {
    throw new ValidationError(source, [
      `is not valid YAML: ${(error as Error).message}`,
    ]);
  }

  const result = GrantsFileSchema.safeParse(raw);
  if (!result.success) throw formatZodError(source, result.error);

  const seen = new Map<string, number>();
  result.data.grants.forEach((g) => seen.set(g.id, (seen.get(g.id) ?? 0) + 1));
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  if (duplicates.length > 0) {
    throw new ValidationError(source, [
      `duplicate grant id(s): ${duplicates.join(", ")}. Every grant needs a unique id`,
    ]);
  }

  return result.data.grants;
}

export function loadGrants(path: string): Grant[] {
  return parseGrants(path, readFileSync(path, "utf8"));
}
