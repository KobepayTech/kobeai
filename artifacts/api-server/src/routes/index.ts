import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import teacherRouter from "./teacher";
import bursarRouter from "./bursar";
import quizzesRouter from "./quizzes";
import walletRouter from "./wallet";
import watchRouter from "./watch";
import watchCompatRouter from "./watch-compat";
import parentRouter from "./parent";
import adminRouter from "./admin";
import printRouter from "./print";
import centralRouter from "./central";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(teacherRouter);
router.use(bursarRouter);
router.use(quizzesRouter);
router.use(walletRouter);
// watch-compat must be first so /v1/watch/login (public) is matched before
// watchRouter's path-prefix `requireAuth` middleware would block it.
router.use(watchCompatRouter);
router.use(watchRouter);
router.use(parentRouter);
router.use(adminRouter);
router.use(printRouter);
router.use(centralRouter);

export default router;
