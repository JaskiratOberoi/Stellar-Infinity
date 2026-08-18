/*
 * 111_table_inf_payment_intent.sql
 *
 * The record that makes an online payment safe to accept.
 *
 * ── WHY THIS TABLE EXISTS ──────────────────────────────────────────────────
 * The legacy razor_update.asmx credits a client's wallet from three strings the
 * CALLER supplies - client, amount, payment id - with no verification that any
 * payment occurred. Any authenticated account, including all ~3,300 client
 * logins, can call it. Its sibling razorCallback.aspx verifies a signature;
 * this one does not.
 *
 * The defence is not "verify harder in the callback". It is to decide the
 * amount BEFORE the customer leaves for the gateway, server-side, and store it
 * here. When the gateway answers, the callback compares what it was told
 * against what we already believed. A response claiming a different amount is
 * a failed payment, not a smaller one, and a response for an order we never
 * minted is not a payment at all.
 *
 * ── IDEMPOTENCY ────────────────────────────────────────────────────────────
 * A gateway callback can arrive twice: the customer refreshes the return page,
 * the gateway retries, a webhook races the redirect. `settled_at` plus the
 * unique tracking id mean the wallet moves exactly once. This is the same
 * discipline as usp_telo_accession_samples' amount_checked latch, and for the
 * same reason: money must be idempotent at the row, not at the caller.
 *
 * Nothing here holds card data - CCAvenue's hosted page takes that and we
 * never see it. This table holds only what we asked for and what came back.
 */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF OBJECT_ID('dbo.inf_payment_intent', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_payment_intent (
        id              INT           IDENTITY(1,1) NOT NULL,
        -- OUR order reference, sent to the gateway and returned by it. Not the
        -- gateway's id: we must be able to recognise our own request before
        -- trusting anything in the response.
        order_ref       VARCHAR(40)   NOT NULL,
        mcc_code        INT           NOT NULL,
        -- What we asked for, in paise-free rupees to match the wallet's own
        -- scale. The ONLY authority on the amount; the browser's copy is a
        -- display.
        amount          DECIMAL(18,2) NOT NULL,
        created_by      INT           NULL,
        created_at      DATETIME2     NOT NULL
            CONSTRAINT DF_inf_payment_intent_created DEFAULT SYSDATETIME(),

        -- Filled in by the verified callback, never before.
        status          VARCHAR(20)   NOT NULL
            CONSTRAINT DF_inf_payment_intent_status DEFAULT 'pending',
        gateway_ref     VARCHAR(60)   NULL,   -- CCAvenue tracking id
        gateway_amount  DECIMAL(18,2) NULL,   -- what the gateway said it took
        gateway_message NVARCHAR(400) NULL,
        settled_at      DATETIME2     NULL,   -- non-null = the wallet has moved

        CONSTRAINT PK_inf_payment_intent PRIMARY KEY (id),
        CONSTRAINT UQ_inf_payment_intent_ref UNIQUE (order_ref),
        CONSTRAINT CK_inf_payment_intent_status
            CHECK (status IN ('pending', 'success', 'failed', 'aborted', 'mismatch')),
        -- A non-positive intent is a bug, not a payment.
        CONSTRAINT CK_inf_payment_intent_amount CHECK (amount > 0)
    );

    -- The callback arrives knowing only the gateway's tracking id.
    CREATE UNIQUE NONCLUSTERED INDEX UX_inf_payment_intent_gateway
        ON dbo.inf_payment_intent (gateway_ref) WHERE gateway_ref IS NOT NULL;

    -- "What has this centre paid, and is anything still open?"
    CREATE NONCLUSTERED INDEX IX_inf_payment_intent_mcc
        ON dbo.inf_payment_intent (mcc_code, created_at DESC) INCLUDE (status, amount);

    PRINT 'Created dbo.inf_payment_intent.';
END
ELSE
    PRINT 'dbo.inf_payment_intent already present.';
GO
