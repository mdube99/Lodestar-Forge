import express from "express";
import {
    allIntegrations,
    createIntegration,
    deleteIntegration,
    checkIntegration,
} from "../controller/integrations.js";
import { authenticatedAdminOrService } from "../middleware/auth.js";

const router = express.Router();

router.get("/", allIntegrations);
router.post("/", authenticatedAdminOrService, createIntegration);
router.delete("/:collectionId", authenticatedAdminOrService, deleteIntegration);
router.post("/check", authenticatedAdminOrService, checkIntegration);

export { router };
