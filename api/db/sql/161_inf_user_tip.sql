/*
 * 161_inf_user_tip.sql
 *
 * Introductory tips — the small "did you know" bubbles that point a user at
 * a control the first times they sign in after it shipped: the dark-mode
 * switch and the report format selector (2026-09-24). Each account sees a
 * tip on at most TWO sign-ins, then never again; "Got it" closes it for the
 * session. Kept per ACCOUNT here rather than in the browser, so the count
 * follows the user across desks and devices and the bubble does not return
 * on every machine they open. Idempotent.
 */
SET NOCOUNT ON;
IF OBJECT_ID('dbo.inf_user_tip') IS NULL
BEGIN
    CREATE TABLE dbo.inf_user_tip (
        user_id    INT           NOT NULL,
        tip        NVARCHAR(40)  NOT NULL,
        shown      INT           NOT NULL CONSTRAINT DF_inf_user_tip_shown DEFAULT (0),
        last_shown DATETIME2     NULL,
        CONSTRAINT PK_inf_user_tip PRIMARY KEY (user_id, tip)
    );
    PRINT 'Created dbo.inf_user_tip.';
END
GO
