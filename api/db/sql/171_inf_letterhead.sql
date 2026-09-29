/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 171_inf_letterhead.sql
 *
 * Per-client letterheads for the standard report. Infinity's own tables; the
 * legacy LIS never reads them.
 *
 * inf_letterhead — one printable layout:
 *   kind 'digital'     the client's artwork is composited into the PDF, for
 *                      plain paper and anything sent digitally
 *   kind 'stationery'  the client's pre-printed sheets: nothing composited,
 *                      only the safe area; an uploaded image is a guide for
 *                      the editor and never printed
 *   first_top_mm / top_mm   the clear band at the head of the first sheet and
 *                           of every later one (a first sheet often carries a
 *                           taller header)
 *   bottom_mm, side_mm      the clear band at the foot and each side
 *   nudge_x_mm / nudge_y_mm a printer's own drift, applied to the content
 *   version                 bumped on every change; it rides in the PDF cache
 *                           key, so an edited letterhead never serves a stale
 *                           PDF
 *
 * inf_client_letterhead — which layout a client's reports default to, one per
 * client code (the LIS unit code, as report scope carries it).
 *
 * Idempotent.
 */
IF OBJECT_ID('dbo.inf_letterhead', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_letterhead (
        id            INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_inf_letterhead PRIMARY KEY,
        name          NVARCHAR(120)  NOT NULL,
        kind          VARCHAR(12)    NOT NULL CONSTRAINT CK_inf_letterhead_kind CHECK (kind IN ('digital', 'stationery')),
        first_top_mm  DECIMAL(5,1)   NOT NULL CONSTRAINT DF_inf_letterhead_first DEFAULT 40,
        top_mm        DECIMAL(5,1)   NOT NULL CONSTRAINT DF_inf_letterhead_top DEFAULT 40,
        bottom_mm     DECIMAL(5,1)   NOT NULL CONSTRAINT DF_inf_letterhead_bottom DEFAULT 40,
        side_mm       DECIMAL(5,1)   NOT NULL CONSTRAINT DF_inf_letterhead_side DEFAULT 14,
        nudge_x_mm    DECIMAL(4,1)   NOT NULL CONSTRAINT DF_inf_letterhead_nx DEFAULT 0,
        nudge_y_mm    DECIMAL(4,1)   NOT NULL CONSTRAINT DF_inf_letterhead_ny DEFAULT 0,
        artwork       VARBINARY(MAX) NULL,
        artwork_mime  VARCHAR(40)    NULL,
        version       INT            NOT NULL CONSTRAINT DF_inf_letterhead_version DEFAULT 1,
        is_active     BIT            NOT NULL CONSTRAINT DF_inf_letterhead_active DEFAULT 1,
        updated_by    INT            NULL,
        updated_at    DATETIME2(0)   NOT NULL CONSTRAINT DF_inf_letterhead_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT CK_inf_letterhead_bands CHECK (
            first_top_mm BETWEEN 0 AND 120 AND top_mm BETWEEN 0 AND 120 AND bottom_mm BETWEEN 0 AND 120
            AND side_mm BETWEEN 0 AND 40 AND first_top_mm + bottom_mm <= 200 AND top_mm + bottom_mm <= 200
            AND nudge_x_mm BETWEEN -10 AND 10 AND nudge_y_mm BETWEEN -10 AND 10)
    );
END
GO
IF OBJECT_ID('dbo.inf_client_letterhead', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_client_letterhead (
        client_code   NVARCHAR(50)  NOT NULL CONSTRAINT PK_inf_client_letterhead PRIMARY KEY,
        letterhead_id INT           NOT NULL CONSTRAINT FK_inf_client_letterhead_lh REFERENCES dbo.inf_letterhead (id),
        updated_by    INT           NULL,
        updated_at    DATETIME2(0)  NOT NULL CONSTRAINT DF_inf_client_letterhead_at DEFAULT SYSUTCDATETIME()
    );
    CREATE INDEX IX_inf_client_letterhead_lh ON dbo.inf_client_letterhead (letterhead_id);
END
GO
PRINT 'inf_letterhead ready';
GO
