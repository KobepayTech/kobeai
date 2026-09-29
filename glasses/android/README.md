# KobeAI Android Teacher Lens

The `companion` app now uses **MoYoung / DA ECHO**. Follow [MOYOUNG.md](MOYOUNG.md)
for implementation scope, build commands, SDK provenance and hardware checks.
Rokid is no longer an active provider.

Build Teacher Lens first (`pnpm --filter @workspace/teacher-lens build`), fetch the
pinned SDK (`python3 glasses/scripts/fetch_moyoung.py` from the repository root),
then run `./gradlew :app:assembleCompanionDebug` here with JDK 17+ and Android SDK 36.

Teacher Lens loads bundled assets only. Native WebMessage access is restricted to
https://appassets.androidplatform.net and the main frame. The school server must
use trusted HTTPS and allow that origin in CORS. Sign in with a teacher account,
open Connections and pair the MoYoung glasses. No developer licence/secret is needed.

Background reconnect lasts while the Activity-owned session exists. Process death
and task removal end it; opening the app starts a fresh reconnect. No background
camera capture is enabled. Pause stops automatic reconnect; Forget deletes pairing.

The legacy separate RayNeo build is not the selected hardware path. Simulator,
Brilliant and Mentra adapters remain in the shared SDK for existing integrations.
