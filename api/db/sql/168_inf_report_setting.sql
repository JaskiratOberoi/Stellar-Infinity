/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 168_inf_report_setting.sql
 *
 * Lab-wide switches for what the standard report prints — the super
 * admin's Reporting settings tab. One row per switch, value as text so a
 * later switch can carry more than on/off. Infinity's own table; the
 * legacy LIS never reads it.
 *
 *   thyroid_figure  '1' prints "Reading this thyroid profile" under a
 *                   thyroid profile's rows (and stands down the legacy
 *                   interpretation text there); '0' prints the report as
 *                   before. The failsafe for the figure's first days.
 *
 * Idempotent.
 */
IF OBJECT_ID('dbo.inf_report_setting', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_report_setting (
        [key]       NVARCHAR(50)  NOT NULL CONSTRAINT PK_inf_report_setting PRIMARY KEY,
        value       NVARCHAR(200) NOT NULL,
        updated_by  INT           NULL,
        updated_at  DATETIME2(0)  NOT NULL CONSTRAINT DF_inf_report_setting_at DEFAULT SYSUTCDATETIME()
    );
END
GO
IF NOT EXISTS (SELECT 1 FROM dbo.inf_report_setting WHERE [key] = N'thyroid_figure')
    INSERT INTO dbo.inf_report_setting ([key], value) VALUES (N'thyroid_figure', N'1');
PRINT 'inf_report_setting ready';
GO
