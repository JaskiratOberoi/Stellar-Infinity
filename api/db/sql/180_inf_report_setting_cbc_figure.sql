/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 180_inf_report_setting_cbc_figure.sql
 *
 * The second reading figure's failsafe switch (see 168 for the table and the
 * first):
 *
 *   cbc_figure  '1' prints "Reading this CBC" under a Complete Blood
 *               Count's rows - the red-cell and white-cell pattern grids,
 *               the platelet scale, the readings and the one-line summary -
 *               and stands down the groups' legacy interpretation text
 *               there; '0' prints the count as before. On from the start,
 *               as the thyroid figure was (07/10/2026).
 *
 * Idempotent.
 */
IF NOT EXISTS (SELECT 1 FROM dbo.inf_report_setting WHERE [key] = N'cbc_figure')
    INSERT INTO dbo.inf_report_setting ([key], value) VALUES (N'cbc_figure', N'1');
PRINT 'cbc_figure ready';
GO
