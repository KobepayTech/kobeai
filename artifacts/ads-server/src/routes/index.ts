import { Router, type IRouter } from "express";
import adsRouter from "./ads";
import advertiserRouter from "./advertiser";
import adminAdsRouter from "./admin-ads";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => res.json({ status: "ok", service: "ads-server" }));
router.use(adsRouter);
router.use(advertiserRouter);
router.use(adminAdsRouter);

export default router;
