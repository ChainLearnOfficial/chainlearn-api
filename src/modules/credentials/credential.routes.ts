import type { FastifyInstance } from "fastify";
import { credentialController } from "./credential.controller.js";
import { authGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import { mintCredentialSchema } from "./credential.types.js";

export async function credentialRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", authGuard);

  app.post(
    "/mint",
    {
      preHandler: [validate({ body: mintCredentialSchema })],
      schema: {
        description: "Mint a course completion credential (NFT)",
        tags: ["credentials"],
      },
    },
    credentialController.mint.bind(credentialController)
  );

  app.get(
    "/",
    {
      schema: {
        description: "List user credentials",
        tags: ["credentials"],
      },
    },
    credentialController.list.bind(credentialController)
  );
}
