/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 81_usp_inf_rate_lists.sql
 *
 * Phase 4c: the rate lists themselves, and what is in them.
 *
 * This closes the loop on phase 1. The catalogue SHOWS a client's negotiated
 * price; until now nothing in Infinity could set one.
 *
 * ── A RATE LIST IS SHARED ──────────────────────────────────────────────────
 * tbl_med_mcc_unit_master.RateType points many clients at one list, so editing
 * a price re-prices every centre on it — not the one whose account someone
 * happens to be looking at. The client count is returned for exactly that
 * reason: a screen that lets you change a number without saying how many
 * customers it affects is a screen that will eventually be used carelessly.
 *
 * Read-only. Writes go through usp_telo_create_rate_list and usp_telo_set_rate,
 * neither of which carries an origin marker — they are configuration, not
 * transactions, so Infinity calls them unchanged.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_rate_lists
    @search NVARCHAR(100) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

    SELECT
        rt.id,
        name = LTRIM(RTRIM(rt.Rate)),
        isActive = CAST(CASE WHEN ISNULL(rt.IsActive, 0) = 1 THEN 1 ELSE 0 END AS BIT),
        -- How many centres this list prices. The number that makes an edit
        -- feel as consequential as it is.
        clientCount = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_unit_master u
                       WHERE u.RateType = rt.id),
        -- How many tests carry a price in it. A list with 12 priced tests out
        -- of 2,000 is mostly falling through to MRP, which is worth seeing
        -- before wondering why a client is billed retail.
        pricedTests = (SELECT COUNT(*) FROM dbo.tbl_med_test_rates_with_pcc_type r
                       WHERE r.RateTypeId = rt.id AND ISNULL(r.IsActive, 0) = 1)
    FROM dbo.tbl_med_test_rate_types rt
    WHERE @search IS NULL OR LTRIM(RTRIM(@search)) = ''
       OR rt.Rate LIKE '%' + @search + '%'
    ORDER BY LTRIM(RTRIM(rt.Rate));
END
GO

/*
 * The tests in one rate list, priced.
 *
 * Every ACTIVE test is returned, not only the ones with a price — the gap is
 * the point. An unpriced test bills the client at MRP, and the only way to
 * notice that is to see it sitting in the list with no rate against it.
 *
 * Tests only. usp_telo_set_rate writes tbl_med_test_rates_with_pcc_type and
 * nothing else, so profiles and master profiles cannot be priced through this
 * path at all — the UI says so rather than quietly listing tests and letting
 * someone assume the profile they were looking for is simply missing.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_rate_list_items
    @rate_type_id INT,
    @search       NVARCHAR(100) = NULL,
    -- 'priced' | 'unpriced' | NULL for both.
    @filter       VARCHAR(10)   = NULL,
    @page         INT           = 1,
    @page_size    INT           = 100
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

    ;WITH items AS (
        SELECT
            t.id,
            code = LTRIM(RTRIM(t.TestCode)),
            name = LTRIM(RTRIM(t.Testname)),
            departmentName = d.Name,
            mrp = t.MRP,
            rate = r.Price
        FROM dbo.tbl_med_test_master t
        LEFT JOIN dbo.tbl_med_department_master d ON d.id = t.DepartmentId
        -- TestCode holds the numeric test id despite the name; see
        -- 78_usp_inf_catalog_search.sql for what joining on the string does.
        LEFT JOIN dbo.tbl_med_test_rates_with_pcc_type r
               ON r.RateTypeId = @rate_type_id
              AND r.TestCode = t.id
              AND ISNULL(r.IsActive, 0) = 1
        WHERE ISNULL(t.IsActive, 0) = 1
          AND (@search IS NULL OR LTRIM(RTRIM(@search)) = ''
               OR t.Testname LIKE '%' + @search + '%'
               OR t.TestCode LIKE '%' + @search + '%')
    )
    SELECT id, code, name, departmentName, mrp, rate,
           COUNT(*) OVER() AS total_count
    FROM items
    WHERE @filter IS NULL
       OR (@filter = 'priced'   AND rate IS NOT NULL)
       OR (@filter = 'unpriced' AND rate IS NULL)
    ORDER BY name, id
    OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY;
END
GO
