import express from "express";
import { 
    getInfrastructureLogs, 
    collectInfrastructureLogs, 
    getInfrastructureLogStats 
} from "../controller/infrastructureLogs.js";
import { authenticatedOperator } from "../middleware/auth.js";

const router = express.Router({ mergeParams: true });

router.get("/", getInfrastructureLogs);
router.get("/stats", getInfrastructureLogStats);
router.post("/collect/:infrastructureId", authenticatedOperator, collectInfrastructureLogs);

export { router };