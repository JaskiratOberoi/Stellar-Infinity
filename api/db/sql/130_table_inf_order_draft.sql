/*
 * 130_table_inf_order_draft.sql
 *
 * Orders typed but NOT yet booked — the LIS's temp-order queue, in Infinity.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * A collection centre sends a batch: one client, many patients, back to back.
 * Until now Infinity booked each one the moment it was placed, so a typo found
 * on the fourth patient meant a real order in Noble to unpick — and there is
 * no unpick. The LIS never worked that way: it holds a run in
 * temp_med_mcc_patient_master / _samples / _tests, lets the operator edit or
 * delete any of them, and only writes the real rows when Submit All is
 * pressed. This table is that queue.
 *
 * ── WHY NOT THE LIS'S OWN temp_ TABLES ─────────────────────────────────────
 * They cannot hold an Infinity order. There is no column for a payment split,
 * none for the Smart Report extra, none for the B2C channel or a Gold Card —
 * so a draft stored there would silently lose exactly the parts that make it
 * an Infinity order, and Submit All would book something the operator never
 * typed. The LIS's own SubmitAllPatientsByMcc also sweeps by CLIENT, not by
 * user, so a receptionist in the LIS would carry off Infinity's drafts as a
 * side effect of finishing their own.
 *
 * ── PAYLOAD IS THE ORDER, VERBATIM ─────────────────────────────────────────
 * A draft is a DEFERRED PLACE CALL: `payload` is the same JSON body the create
 * endpoint already takes, stored whole. Nothing is re-modelled into columns,
 * because every column would be a second description of the order that has to
 * be kept in step with the first — and the first is the one that books. The
 * few columns beside it are there only so the list can be drawn without
 * parsing every payload, and are refreshed from the payload on every save.
 *
 * Private to its author, by decision: two receptionists working the same
 * client must not submit each other's half-typed patients. mcc_code is still
 * stored, because a draft is priced for one client and the list is drawn per
 * client — changing the client mid-run must not show a queue priced for
 * another one.
 *
 * last_error is why Submit All left this row behind. A submission books what
 * it can and keeps the rest here with the reason on them, so one deactivated
 * test cannot block a morning's queue.
 */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF OBJECT_ID('dbo.inf_order_draft', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_order_draft (
        id            INT             IDENTITY(1,1) NOT NULL,
        user_id       INT             NOT NULL,
        mcc_code      INT             NOT NULL,
        -- Drawn in the list; derived from payload on every save, never edited
        -- on its own.
        patient_name  NVARCHAR(200)   NULL,
        total         INT             NOT NULL CONSTRAINT DF_inf_order_draft_total DEFAULT (0),
        tubes         INT             NOT NULL CONSTRAINT DF_inf_order_draft_tubes DEFAULT (0),
        sids          INT             NOT NULL CONSTRAINT DF_inf_order_draft_sids  DEFAULT (0),
        payload       NVARCHAR(MAX)   NOT NULL,
        last_error    NVARCHAR(500)   NULL,
        created_at    DATETIME2(0)    NOT NULL CONSTRAINT DF_inf_order_draft_created DEFAULT (SYSDATETIME()),
        updated_at    DATETIME2(0)    NOT NULL CONSTRAINT DF_inf_order_draft_updated DEFAULT (SYSDATETIME()),
        CONSTRAINT PK_inf_order_draft PRIMARY KEY CLUSTERED (id),
        CONSTRAINT FK_inf_order_draft_user FOREIGN KEY (user_id)
            REFERENCES dbo.tbl_med_user_master (id)
    );

    -- The list query, exactly: one user's queue for the client on screen,
    -- oldest first so the run reads in the order it was typed.
    CREATE INDEX IX_inf_order_draft_owner
        ON dbo.inf_order_draft (user_id, mcc_code, id);
END
GO
