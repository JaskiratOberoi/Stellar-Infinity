/*
 * 128_table_inf_audit_log.sql — persistent audit trail for the Infinity
 * platform.
 *
 * Modelled on Telo's telo_audit_log (25_table_telo_audit_log.sql), which
 * itself improved on the LIS's TBL_MED_USER_ACTIVITY_LOG: machine-readable
 * `kind` plus a JSON `details` payload instead of one free-text prose column.
 * The two platform trails stay in separate tables — each app owns its own
 * writer — and Infinity's VIEWER reads both, so the lab has one feed across
 * both systems without either app writing into the other's table.
 *
 * Two columns Telo's table does not have, both for correlation:
 *   bill_id  the bill an event concerns, when it concerns exactly one. Telo
 *            buries this inside the JSON, so "everything that ever happened
 *            to this bill" needs a table scan there. Here it is a real
 *            indexed column, and the order dialog shows the event history.
 *   sid      likewise for a sample barcode (the LIS's VAILID) — the report
 *            events carry it, and it correlates with the LIS trail's
 *            SAMPLEID column.
 *
 * ip is the caller's address as the API saw it (X-Forwarded-For aware) — the
 * LIS trail records it, Telo's dropped it, and sign-in disputes want it.
 *
 * NEVER stores passwords, card data, or full PII — identifiers and outcomes
 * only. Writes are fire-and-forget from the app (an audit insert must never
 * fail or slow a business action), so no FKs: actor_id may reference a user
 * later deleted on the LIS side, and login failures have a username but no
 * id.
 */
IF OBJECT_ID('dbo.inf_audit_log', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_audit_log (
        id        BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_inf_audit_log PRIMARY KEY,
        at        DATETIME2(3) NOT NULL CONSTRAINT DF_inf_audit_log_at DEFAULT SYSDATETIME(),
        kind      VARCHAR(60)  NOT NULL,
        /* Acting user's tbl_med_user_master.id when known. */
        actor_id  INT          NULL,
        /* Username as typed — for login.failure, where no id exists. */
        username  NVARCHAR(50) NULL,
        /* The one bill this event concerns, when it concerns exactly one. */
        bill_id   INT          NULL,
        /* The one sample barcode this event concerns, when it concerns one. */
        sid       NVARCHAR(50) NULL,
        /* Caller's address as the API saw it. */
        ip        VARCHAR(45)  NULL,
        /* Remaining event fields as compact JSON ({mcc:…, total:…, …}). */
        details   NVARCHAR(2000) NULL
    );

    /* The viewer's hot paths: newest-first, per kind-prefix, per actor — and
       the two correlation columns that are this table's reason to differ. */
    CREATE NONCLUSTERED INDEX IX_inf_audit_log_at
        ON dbo.inf_audit_log (at DESC);
    CREATE NONCLUSTERED INDEX IX_inf_audit_log_kind_at
        ON dbo.inf_audit_log (kind, at DESC);
    CREATE NONCLUSTERED INDEX IX_inf_audit_log_actor_at
        ON dbo.inf_audit_log (actor_id, at DESC);
    CREATE NONCLUSTERED INDEX IX_inf_audit_log_bill
        ON dbo.inf_audit_log (bill_id) WHERE bill_id IS NOT NULL;
    CREATE NONCLUSTERED INDEX IX_inf_audit_log_sid
        ON dbo.inf_audit_log (sid) WHERE sid IS NOT NULL;
END
