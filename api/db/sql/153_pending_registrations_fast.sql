/*
 * 153_pending_registrations_fast.sql
 *
 * The accessioning queue took 0.7–1.4 s per load and 1.2 s per Sample-ID
 * search; measured ad hoc the same predicates ran in 25–35 ms. Two causes,
 * both in the procedure, neither in the data:
 *
 *   1. One cached plan for every filter combination. The optional filters are
 *      written as `(@x IS NULL OR col = @x)`, and the plan compiled for the
 *      first caller's parameters is reused for all the rest — a shape that
 *      scans where a seek was available. OPTION (RECOMPILE) lets each call
 *      plan for the parameters it actually has, exactly as the inward list
 *      already does; at a few calls a minute the compile is nothing.
 *   2. The Sample-ID filter was `LIKE '%sid%'`, which no index can serve, so
 *      every SID search walked the 348,000 tubes still at Sample Sent. A
 *      barcode is scanned whole and a typed one is typed from the start, so
 *      the filter is now a PREFIX match — served by IX_patient_samples_vailid
 *      in under a millisecond. The one thing lost is finding a SID by its
 *      middle digits, which nobody at a receiving desk does.
 *
 * Everything else — columns, joins, paging, scope — is unchanged from 79.
 */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO
CREATE OR ALTER PROCEDURE dbo.usp_inf_pending_registrations
    @client_codes  dbo.ClientCodeList READONLY,
    @page          INT           = 1,
    @page_size     INT           = 100,
    @from_date     DATE          = NULL,   -- on addeddate; NULL = no lower bound
    @to_date       DATE          = NULL,   -- inclusive; NULL = no upper bound
    @sid           NVARCHAR(50)  = NULL,   -- STARTS WITH (153; was contains)
    @patient       NVARCHAR(100) = NULL,   -- name or mobile contains
    @origin        VARCHAR(10)   = NULL,   -- 'lis' | 'telo' | 'infinity' | NULL for all
    @business_unit INT           = NULL    -- the CLIENT's business unit
AS
BEGIN
    SET NOCOUNT ON;
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

    DECLARE @pageSafe INT = CASE WHEN @page < 1 THEN 1 ELSE @page END;
    DECLARE @size INT =
        CASE WHEN @page_size < 1 THEN 100
             WHEN @page_size > 1000 THEN 1000
             ELSE @page_size END;
    DECLARE @offset INT = (@pageSafe - 1) * @size;

    DECLARE @codeCount INT = (SELECT COUNT(*) FROM @client_codes);
    DECLARE @from DATETIME = CASE WHEN @from_date IS NULL THEN NULL ELSE CAST(@from_date AS DATETIME) END;
    DECLARE @to   DATETIME = CASE WHEN @to_date   IS NULL THEN NULL ELSE DATEADD(DAY, 1, CAST(@to_date AS DATETIME)) END;
    DECLARE @sidSafe NVARCHAR(50)  = NULLIF(LTRIM(RTRIM(@sid)), N'');
    DECLARE @patSafe NVARCHAR(100) = NULLIF(LTRIM(RTRIM(@patient)), N'');
    DECLARE @originSafe VARCHAR(10) = NULLIF(LOWER(LTRIM(RTRIM(@origin))), '');

    SELECT
        s.id            AS sampleId,
        s.vailid        AS vailid,
        s.patient_id    AS patientId,
        p.name          AS patientName,
        p.mobile_number AS mobile,
        p.mcc_code      AS mccCode,
        u.MCCUnitCode   AS clientCode,
        bu.BusinessUnitName AS businessUnit,
        s.sample_status AS sampleStatus,
        st.Sampletype   AS sampleTypeName,
        s.testnames     AS testNames,
        s.addeddate     AS addedAt,
        s.addedby       AS registeredBy,
        origin = CASE WHEN s.addedby LIKE 'inf:%'  THEN 'infinity'
                      WHEN s.addedby LIKE 'telo:%' THEN 'telo'
                      ELSE 'lis' END,
        COUNT(*) OVER() AS total_count
    FROM dbo.tbl_med_mcc_patient_samples s
    JOIN dbo.tbl_med_mcc_patient_master p ON p.id = s.patient_id
    LEFT JOIN dbo.tbl_med_mcc_unit_master u ON u.id = p.mcc_code
    LEFT JOIN dbo.tbl_med_business_unit_master bu ON bu.id = u.BusinessUnitCode
    LEFT JOIN dbo.tbl_med_sample_master st ON st.id = s.sampleid
    WHERE s.sample_status = 1
      AND (@from IS NULL OR s.addeddate >= @from)
      AND (@to   IS NULL OR s.addeddate <  @to)
      -- Prefix, not contains: sargable on the vailid index (153).
      AND (@sidSafe IS NULL OR s.vailid LIKE @sidSafe + N'%')
      AND (@patSafe IS NULL OR p.name LIKE '%' + @patSafe + '%'
                            OR p.mobile_number LIKE '%' + @patSafe + '%')
      AND (@originSafe IS NULL
           OR @originSafe = CASE WHEN s.addedby LIKE 'inf:%'  THEN 'infinity'
                                 WHEN s.addedby LIKE 'telo:%' THEN 'telo'
                                 ELSE 'lis' END)
      AND (@business_unit IS NULL OR u.BusinessUnitCode = @business_unit)
      AND (@codeCount = 0
           OR EXISTS (SELECT 1 FROM @client_codes c WHERE c.code = u.MCCUnitCode))
    ORDER BY s.addeddate DESC, s.id DESC
    OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY
    -- Each call plans for the filters it actually carries (153).
    OPTION (RECOMPILE);
END
GO
PRINT 'usp_inf_pending_registrations: recompiled per call, Sample ID by prefix.';
