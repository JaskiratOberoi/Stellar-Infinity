/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 78_usp_inf_catalog_search.sql
 *
 * The test catalogue, priced for ONE client, paged.
 *
 * Phase 1 of bringing Telo's ordering pipeline into Infinity. Everything an
 * order needs starts here: you cannot build a cart without knowing what the
 * client pays for each item.
 *
 * ── THE PRICE MUST MATCH WHAT WILL BE BILLED ───────────────────────────────
 * Three tiers, in the order the LIS billing path (CheckTransCash / GetTestRate)
 * applies them, mirrored from dbo.usp_telo_resolve_rate so the catalogue shows
 * the price the order will actually charge:
 *
 *   special  tbl_med_mcc_test_special_rates for this MCC and item. Outranks
 *            everything, including the rate list.
 *   ratelist the price for this item in the rate list assigned to the MCC via
 *            tbl_med_mcc_unit_master.RateType.
 *   mrp      the catalogue MRP.
 *   none     no price at all — the item cannot be billed to this client.
 *
 * ── A TRAP WORTH NAMING ────────────────────────────────────────────────────
 * The rate-list tables call their key columns TestCode, profilecode and
 * master_profile_code, but all three hold the numeric ID of the catalogue row,
 * NOT the human test code ('HE011'). Joining on the string code silently
 * matches nothing, every item falls through to MRP, and a B2B client gets
 * billed retail. The joins below are on id, deliberately.
 *
 * ── WHY SET-BASED RATHER THAN TELO'S APPROACH ──────────────────────────────
 * Telo loads the whole catalogue plus three rate maps into memory and merges
 * them in JavaScript. That is fine for one server; here it would mean shipping
 * the entire catalogue to page through it, which is the pattern this codebase
 * has been removing everywhere else. This resolves and pages in SQL and returns
 * total_count, so the catalogue obeys the same rule as every other list.
 *
 * Read-only.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_catalog_search
    -- NULL prices everything at MRP, which is the legacy "no client selected"
    -- view rather than an error.
    @mcc       INT           = NULL,
    @search    NVARCHAR(100) = NULL,
    -- 'test' | 'profile' | 'master'. NULL returns all three.
    @kind      VARCHAR(10)   = NULL,
    @page      INT           = 1,
    @page_size INT           = 100
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

    -- The client's assigned rate list. NULL means they have none, in which case
    -- special rates still apply and everything else falls through to MRP.
    DECLARE @rateType INT =
        (SELECT RateType FROM dbo.tbl_med_mcc_unit_master WHERE id = @mcc);

    ;WITH cat AS (
        SELECT id, kind = 'test',
               code = TestCode, name = Testname,
               department_id = DepartmentId, mrp = MRP
        FROM dbo.tbl_med_test_master
        WHERE ISNULL(IsActive, 0) = 1

        UNION ALL

        SELECT id, 'profile',
               Profile_Code, Profile_Name,
               department_id, MRP
        FROM dbo.tbl_med_test_profile_master
        WHERE ISNULL(IsActive, 0) = 1

        UNION ALL

        SELECT id, 'master',
               Master_Profile_Code, Master_Profile_Name,
               NULL, MRP
        FROM dbo.tbl_med_test_master_profile_master
        WHERE ISNULL(IsActive, 0) = 1
    ),
    filtered AS (
        SELECT c.id, c.kind, c.code, c.name, c.mrp,
               department_name = d.Name
        FROM cat c
        LEFT JOIN dbo.tbl_med_department_master d ON d.id = c.department_id
        WHERE (@kind IS NULL OR c.kind = @kind)
          AND (
                @search IS NULL OR LTRIM(RTRIM(@search)) = ''
                OR c.name LIKE '%' + @search + '%'
                OR c.code LIKE '%' + @search + '%'
              )
    ),
    priced AS (
        SELECT f.*,
               special_rate  = sp.rate,
               ratelist_rate = rl.Price
        FROM filtered f

        -- OUTER APPLY with TOP 1 rather than a plain join: a duplicate rate row
        -- for one item would otherwise multiply the catalogue row, quietly
        -- inflating both the listing and total_count.
        OUTER APPLY (
            SELECT TOP 1 s.rate
            FROM dbo.tbl_med_mcc_test_special_rates s
            WHERE @mcc IS NOT NULL
              AND s.mcccode = @mcc
              AND s.testid = f.id
              AND s.testtype = CASE f.kind
                                   WHEN 'test' THEN 'T'
                                   WHEN 'profile' THEN 'P'
                                   ELSE 'M'
                               END
        ) sp

        OUTER APPLY (
            SELECT TOP 1 x.Price
            FROM (
                -- Keyed on the numeric id in all three, despite the column
                -- names. See the header.
                SELECT t.Price
                FROM dbo.tbl_med_test_rates_with_pcc_type t
                WHERE f.kind = 'test' AND @rateType IS NOT NULL
                  AND t.RateTypeId = @rateType AND t.TestCode = f.id
                  AND ISNULL(t.IsActive, 0) = 1

                UNION ALL

                SELECT p.Price
                FROM dbo.tbl_med_profile_rates_with_pcc_types p
                WHERE f.kind = 'profile' AND @rateType IS NOT NULL
                  AND p.RateTypeId = @rateType AND p.profilecode = f.id
                  AND ISNULL(p.IsActive, 0) = 1

                UNION ALL

                SELECT m.Price
                FROM dbo.tbl_med_master_profile_rates_with_pcc_types m
                WHERE f.kind = 'master' AND @rateType IS NOT NULL
                  AND m.RateTypeId = @rateType AND m.master_profile_code = f.id
                  AND ISNULL(m.IsActive, 0) = 1
            ) x
        ) rl
    )
    SELECT
        kind,
        id,
        code = LTRIM(RTRIM(code)),
        name = LTRIM(RTRIM(name)),
        department_name,
        mrp,
        rate = COALESCE(special_rate, ratelist_rate, mrp),
        -- Returned so the operator can see WHY a price is what it is. A B2B
        -- item silently falling through to MRP is a margin leak, and naming the
        -- tier is what makes it visible.
        rate_source = CASE
            WHEN special_rate  IS NOT NULL THEN 'special'
            WHEN ratelist_rate IS NOT NULL THEN 'ratelist'
            WHEN mrp           IS NOT NULL THEN 'mrp'
            ELSE 'none'
        END,
        COUNT(*) OVER() AS total_count
    FROM priced
    -- id breaks ties on duplicate names, without which OFFSET paging could
    -- repeat one item and hide another.
    ORDER BY name, kind, id
    OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY;
END
GO
