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
}

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
