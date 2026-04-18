package com.kobeai.watch.data.remote

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.Path

/**
 * Retrofit interface for the KobeAI watch endpoints.
 *
 * The server exposes a `/api/v1/watch/...` compatibility surface that wraps the
 * core REST endpoints (auth, quizzes, wallet, ai) so the watch can use a single
 * stable URL prefix.
 */
interface ApiService {

    // -- Ad exchange ----------------------------------------------------------
    // Public — no auth header. Server uses HMAC-signed impression tokens to
    // tie the click event back to the served impression.
    // The ads exchange runs as its own service mounted at `/ads-api/*`.
    // Retrofit's @Url annotation lets us call an absolute path different
    // from the default base, so we keep one Retrofit client.
    @GET
    suspend fun getAd(
        @retrofit2.http.Url url: String = "ads-api/v1/ads/serve",
        @retrofit2.http.Query("placement") placement: String,
    ): AdServeResponse

    @POST
    suspend fun postAdEvent(
        @Body body: AdEventRequest,
        @retrofit2.http.Url url: String = "ads-api/v1/ads/event",
    ): AdEventResponse

    @POST("api/v1/watch/login")
    suspend fun login(@Body request: LoginRequest): LoginResponse

    @POST("api/v1/watch/ask")
    suspend fun askQuestion(
        @Header("Authorization") token: String,
        @Body request: QuestionRequest
    ): QuestionResponse

    @GET("api/v1/watch/quizzes")
    suspend fun getQuizzes(@Header("Authorization") token: String): QuizListResponse

    @GET("api/v1/watch/quiz/{quizId}/start")
    suspend fun startQuiz(
        @Header("Authorization") token: String,
        @Path("quizId") quizId: String
    ): StartQuizResponse

    @POST("api/v1/watch/quiz/{quizId}/submit")
    suspend fun submitQuiz(
        @Header("Authorization") token: String,
        @Path("quizId") quizId: String,
        @Body request: SubmitQuizRequest
    ): SubmitQuizResponse

    @POST("api/v1/watch/attendance/checkin")
    suspend fun checkIn(@Header("Authorization") token: String): AttendanceResponse

    @GET("api/v1/watch/wallet")
    suspend fun getWallet(@Header("Authorization") token: String): WalletResponse

    @GET("api/v1/watch/subscription")
    suspend fun getSubscription(@Header("Authorization") token: String): SubscriptionResponse

    @POST("api/v1/watch/sync")
    suspend fun sync(
        @Header("Authorization") token: String,
        @Body request: SyncRequest
    ): SyncResponse

    // -------- Stationery (parent-approved supply orders from the watch) ----
    @GET("api/v1/watch/stationery/drive")
    suspend fun getStationeryDrive(
        @Header("Authorization") token: String
    ): StationeryDriveResponse

    @POST("api/v1/watch/stationery/order")
    suspend fun submitStationeryOrder(
        @Header("Authorization") token: String,
        @Body request: StationeryOrderRequest
    ): StationeryOrderResponse

    @POST("api/v1/watch/heartbeat")
    suspend fun heartbeat(
        @Header("Authorization") token: String,
        @Body request: HeartbeatRequest
    ): HeartbeatResponse

    @GET("api/v1/watch/settings")
    suspend fun getWatchSettings(
        @Header("Authorization") token: String
    ): WatchSettingsResponse

    @GET("api/v1/watch/leaderboard")
    suspend fun getLeaderboard(
        @Header("Authorization") token: String
    ): LeaderboardResponse

    @GET("api/v1/watch/timetable/today")
    suspend fun getTimetableToday(
        @Header("Authorization") token: String
    ): TimetableTodayResponse

    @GET("api/v1/watch/timetable/current")
    suspend fun getTimetableCurrent(
        @Header("Authorization") token: String
    ): TimetableCurrentResponse

    @GET("api/v1/watch/exam/active")
    suspend fun getActiveExam(
        @Header("Authorization") token: String
    ): ActiveExamResponse

    // ---------- Mini-app store ----------
    @GET("api/v1/store/feed")
    suspend fun getStoreFeed(
        @Header("Authorization") token: String
    ): StoreFeedResponse

    @GET("api/v1/store/apps")
    suspend fun getStoreApps(
        @Header("Authorization") token: String,
        @retrofit2.http.Query("category") category: String? = null
    ): StoreAppsResponse

    @GET("api/v1/store/apps/{id}")
    suspend fun getStoreApp(
        @Header("Authorization") token: String,
        @Path("id") id: Int
    ): StoreAppDetailResponse

    @GET("api/v1/store/installed")
    suspend fun getStoreInstalled(
        @Header("Authorization") token: String
    ): StoreInstalledResponse

    @POST("api/v1/store/apps/{id}/install")
    suspend fun installStoreApp(
        @Header("Authorization") token: String,
        @Path("id") id: Int
    ): StoreOkResponse

    @POST("api/v1/store/apps/{id}/purchase")
    suspend fun purchaseStoreApp(
        @Header("Authorization") token: String,
        @Path("id") id: Int,
        @Body req: PurchaseRequest
    ): StoreOkResponse

    @POST("api/v1/store/apps/{id}/complete")
    suspend fun completeStoreApp(
        @Header("Authorization") token: String,
        @Path("id") id: Int
    ): StoreCompleteResponse
}

data class StoreApp(
    val id: Int,
    val slug: String,
    val name: String,
    val description: String?,
    val icon: String?,
    val category: String,
    val type: String,
    val price_kp: Int,
    val price_tsh: Int,
    val total_installs: Int,
    val rating: Double?,
    val rating_count: Int,
)

data class StoreCategory(val category: String, val apps: List<StoreApp>)

data class StoreFeedResponse(val featured: List<StoreApp>, val categories: List<StoreCategory>)

data class StoreAppsResponse(val apps: List<StoreApp>)

data class StoreAppDetailResponse(
    val app: StoreApp,
    val developer: StoreDeveloper?,
    val manifest: Map<String, Any?>?,
    val installed: Boolean,
    val reviews: List<StoreReview>,
)

data class StoreDeveloper(val id: Int, val name: String, val website: String?)

data class StoreReview(
    val id: Int,
    val rating: Int,
    val comment: String?,
    val created_at: String,
)

data class StoreInstall(
    val install_id: Int,
    val installed_at: String,
    val paid: Boolean,
    val app: StoreApp?,
    val manifest: Map<String, Any?>?,
)

data class StoreInstalledResponse(val installs: List<StoreInstall>)

data class PurchaseRequest(val currency: String) // "kp" or "tsh"

data class StoreOkResponse(val ok: Boolean)

data class StoreCompleteResponse(val ok: Boolean, val awarded_kp: Int)

data class TimetableTodayResponse(
    val day_of_week: Int,
    val periods: List<TimetablePeriod>,
)

data class TimetablePeriod(
    val id: Int,
    val day_of_week: Int,
    val start_minute: Int,
    val end_minute: Int,
    val subject: String,
    val room: String?,
    val teacher_name: String?,
)

data class TimetableCurrentResponse(
    val current: CurrentPeriod?,
    val next: NextPeriod?,
    val server_minute: Int,
)

data class CurrentPeriod(
    val id: Int,
    val subject: String,
    val room: String?,
    val teacher_name: String?,
    val start_minute: Int,
    val end_minute: Int,
    val minutes_remaining: Int,
)

data class NextPeriod(
    val id: Int,
    val subject: String,
    val room: String?,
    val start_minute: Int,
    val end_minute: Int,
    val minutes_until: Int,
)

data class ActiveExamResponse(
    val active: Boolean,
    val exam: ActiveExam? = null,
)

data class ActiveExam(
    val id: Int,
    val class_id: Int,
    val title: String,
    val status: String,
    val initial_seconds: Int,
    val seconds_added: Int,
    val remaining_seconds: Int,
    val ends_at: String?,
)

data class LeaderboardResponse(
    val leaderboard: List<LeaderboardEntry>,
    val scope: String
)

data class LeaderboardEntry(
    val rank: Int,
    val student_code: String,
    val student_name: String,
    val total_points: Int,
    val avg_score: Int,
    val quizzes_taken: Int,
    val is_me: Boolean,
)

data class WatchSettingsResponse(
    val audio_enabled: Boolean,
    val keyboard_enabled: Boolean,
)

// --- Request / response models -------------------------------------------------

data class LoginRequest(
    val student_id: String,
    val pin: String,
    val device_id: String
)

data class LoginResponse(
    val success: Boolean,
    val token: String,
    val student_name: String,
    val grade: String,
    val wallet_balance: Int,
    val pending_quizzes: Int
)

data class QuestionRequest(
    val question: String,
    val subject: String? = null
)

data class QuestionResponse(
    val answer: String,
    val points_earned: Int,
    val new_balance: Int,
    val follow_up_suggestions: List<String>,
    val conversation_id: String
)

data class QuizListResponse(val quizzes: List<QuizSummary>)

data class QuizSummary(
    val id: String,
    val title: String,
    val subject: String,
    val questions_count: Int,
    val points_possible: Int,
    val duration_minutes: Int
)

data class StartQuizResponse(
    val attempt_id: String,
    val quiz_id: String,
    val title: String,
    val questions: List<QuizQuestion>,
    val time_limit_minutes: Int,
    val total_points: Int
)

data class QuizQuestion(
    val id: String,
    val text: String,
    val options: List<String>,
    val points: Int
)

data class SubmitQuizRequest(val answers: Map<String, String>)

data class SubmitQuizResponse(
    val score: Int,
    val points_earned: Int,
    val new_balance: Int,
    val feedback: String
)

data class AttendanceResponse(
    val success: Boolean,
    val message: String,
    val points_earned: Int,
    val new_balance: Int,
    val already_checked_in: Boolean
)

data class WalletResponse(
    val balance: Int,
    val total_earned: Int,
    val level: Int,
    val recent_transactions: List<TransactionItem>
)

data class TransactionItem(
    val amount: Int,
    val type: String,
    val description: String,
    val created_at: String
)

data class SyncRequest(
    val offline_questions: List<OfflineQuestion>,
    val device_info: Map<String, String>
)

data class OfflineQuestion(
    val id: String,
    val question: String,
    val subject: String?,
    val timestamp: Long
)

data class SyncResponse(
    val new_quizzes: List<QuizSummary>,
    val wallet_balance: Int
)

data class HeartbeatRequest(
    val device_id: String,
    val battery_level: Int
)

data class HeartbeatResponse(val success: Boolean)

data class SubscriptionResponse(
    val has_subscription: Boolean,
    val status: String,
    val plan: String?,
    val expires_at: String?,
    val days_until_expiry: Int?,
    val monthly_price_tsh: Int,
    val parent_phone: String?,
    val severity: String,
    val message: String
)

// ---------------------------------------------------------------------------
// Stationery — drive list + cart submission. The server returns the catalog
// already priced for THIS school's tenant, so the watch never has to do FX
// or rule-based math; it just shows the price and submits selected lines.
// ---------------------------------------------------------------------------
data class StationeryDriveResponse(
    val drive: StationeryDrive?,
    val items: List<StationeryItem>
)

data class StationeryDrive(
    val id: Int,
    val title: String,
    val opens_at: String?,
    val closes_at: String?
)

data class StationeryItem(
    val id: Int,
    val name: String,
    val unit: String?,
    val price_tsh: Int,
    val category: String?
)

data class StationeryOrderRequest(
    val lines: List<StationeryOrderLine>
)

data class StationeryOrderLine(
    val item_id: Int,
    val qty: Int
)

data class StationeryOrderResponse(
    val order_id: Int,
    val total_tsh: Int
)

// -- Ad exchange models ------------------------------------------------------
data class AdServeResponse(val ad: AdPayload?)
data class AdPayload(
    val impression_token: String,
    val placement_id: String,
    val campaign_id: Int,
    val creative: AdCreative,
)
data class AdCreative(
    val id: Int,
    val format: String,
    val title: String,
    val body: String?,
    val image_url: String?,
    val cta_url: String,
    val cta_label: String?,
    val width: Int?,
    val height: Int?,
)
data class AdEventRequest(val token: String, val type: String) // type: "impression" | "click"
data class AdEventResponse(val ok: Boolean)
