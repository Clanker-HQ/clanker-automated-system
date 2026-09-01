import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  APPROVALS, CATEGORIES, EFFORTS, MODELS, TIERS, TOOLS, AgentSchema,
} from "../src/agent-schema.js";

mkdirSync("schema", { recursive: true });

writeFileSync(
  "schema/agent.schema.json",
  JSON.stringify(z.toJSONSchema(AgentSchema, { io: "input" }), null, 2) + "\n",
);

writeFileSync(
  "schema/capabilities.json",
  JSON.stringify(
    {
      description:
        "The complete menu of legal values for an agent.yaml. Read this before authoring one.",
      tools: TOOLS,
      tiers: TIERS,
      approvalModes: APPROVALS,
      models: MODELS,
      efforts: EFFORTS,
      categories: CATEGORIES,
      triggerTypes: ["cron"],
      notYetAvailable: {
        "capabilities.browser.enabled": "Plan C (browser capability)",
        "trigger.type: webhook": "Plan B (trigger adapters)",
      },
      neverPermitted: [
        "creating accounts or identities of any kind",
        "registering domains",
        "adding or using payment methods",
      ],
    },
    null,
    2,
  ) + "\n",
);

console.log("wrote schema/agent.schema.json and schema/capabilities.json");
