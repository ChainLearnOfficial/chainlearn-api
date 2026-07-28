import type { FastifyInstance, FastifySchema } from "fastify";
import { credentialController } from "./credential.controller.js";
import { authGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import { mintCredentialSchema } from "./credential.types.js";

export async function credentialRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", authGuard);

  app.post<{ Body: import("./credential.types.js").MintCredentialBody }>(
    "/mint",
    {
      preHandler: [validate({ body: mintCredentialSchema })],
      schema: {
        description: "Mint a course completion credential (NFT)",
        tags: ["credentials"],
      } as FastifySchema,
    },
    (request, reply) => credentialController.mint(request, reply)
  );

  app.get(
    "/",
    {
      schema: {
        description: "List user credentials",
        tags: ["credentials"],
      } as FastifySchema,
    },
    (request, reply) => credentialController.list(request, reply)
  );
}
