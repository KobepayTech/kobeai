package com.kobeai.watch.data.remote

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path

/**
 * Retrofit interface for tap-to-print endpoints.
 *
 * After a tap, the watch polls `pairing` every ~1.5s. Once a pairing appears
 * for this student, the file picker is shown. Submit returns a job_id which
 * we then poll via `job` for status updates.
 */
interface PrintApiService {

    @GET("api/v1/print/pairing-for-session/{sessionId}")
    suspend fun lookupPairingForSession(
        @Path("sessionId") sessionId: String
    ): retrofit2.Response<PrintPairingLookupResponse>

    @GET("api/v1/print/pairing/{id}")
    suspend fun getPairing(@Path("id") id: String): PrintPairingResponse

    @POST("api/v1/print/submit")
    suspend fun submit(@Body request: PrintSubmitRequest): PrintSubmitResponse

    @GET("api/v1/print/jobs/{id}")
    suspend fun getJob(@Path("id") id: String): PrintJobResponse
}

// --- Models -----------------------------------------------------------------

data class PrintPairingLookupResponse(
    val pairing_id: String,
    val expires_at: Long
)

data class PrintPairingResponse(
    val pairing_id: String,
    val student_id: String,
    val printer: PrintPrinter,
    val files: List<PrintFile>,
    val expires_at: Long,
    val job_id: String?
)

data class PrintPrinter(
    val id: String,
    val name: String,
    val location: String,
    val model: String
)

data class PrintFile(
    val id: String,
    val name: String,
    val subject: String,
    val size_kb: Int,
    val pages: Int
)

data class PrintSubmitRequest(
    val pairing_id: String,
    val document_id: String,
    val watch_signature: String
)

data class PrintSubmitResponse(
    val job_id: String,
    val status: String,
    val document_name: String
)

data class PrintJobResponse(
    val id: String,
    val pairing_id: String,
    val student_id: String,
    val printer_id: String,
    val document_id: String,
    val document_name: String,
    val status: String,
    val status_message: String,
    val created_at: Long,
    val expires_at: Long
)
