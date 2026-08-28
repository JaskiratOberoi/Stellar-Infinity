SET QUOTED_IDENTIFIER ON;
GO
/*
 * 100_usp_inf_order_referrers.sql
 *
 * The referring doctors and customers an order can be booked against.
 *
 * The write side has accepted these since order entry was built —
 * usp_inf_create_order takes @refDoctor / @refCustomer and the
 * @newRefDoctorName / @newRefCustomerName pair that upserts one — but nothing
 * ever offered the operator a way to pick. This is the missing read.
 *
 * Two small lists (about 1,400 doctors, 300 customers), handed over once and
 * filtered in the browser, for the same reason the test catalogue is: the
 * operator searches by name, and a round trip per keystroke buys nothing at
 * this size.
 *
 * SCOPED to the centre the order is being booked under, matching both the LIS
 * (Workorder_FillCombo filters pcc_code to the selected MCC) and Telo
 * (fetchDoctorsForMcc). The first version handed the whole network's roster
 * to every account, which offered one centre's referring doctors — a
 * commercially sensitive list — to every other centre. @mcc NULL keeps the
 * old unscoped answer so an already-deployed API survives the procedure
 * landing first; the API always passes the centre.
 *
 * Filtered on IsActive HERE and not in the management list: deactivating a
 * referrer is precisely the act of removing it from this picker (the legacy
 * combos never filtered it, which is listed as a defect — deactivation there
 * did nothing). Historical orders keep their name via the join on id, active
 * or not.
 *
 * Read-only.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_order_referrers
    @mcc INT = NULL
AS
BEGIN
    SET NOCOUNT ON;

    -- 1. doctors
    SELECT
        d.id,
        LTRIM(RTRIM(ISNULL(d.doctor_code, ''))) AS code,
        LTRIM(RTRIM(ISNULL(d.doctor_name, ''))) AS name
    FROM dbo.tbl_med_mcc_doctors d
    WHERE ISNULL(d.doctor_name, '') <> ''
      AND (@mcc IS NULL OR (d.pcc_code = @mcc AND ISNULL(d.IsActive, 1) = 1))
    ORDER BY d.doctor_name;

    -- 2. customers
    SELECT
        c.id,
        LTRIM(RTRIM(ISNULL(c.customer_code, ''))) AS code,
        LTRIM(RTRIM(ISNULL(c.customer_name, ''))) AS name
    FROM dbo.tbl_med_mcc_customer c
    WHERE ISNULL(c.customer_name, '') <> ''
      AND (@mcc IS NULL OR (c.pcc_code = @mcc AND ISNULL(c.IsActive, 1) = 1))
    ORDER BY c.customer_name;
END
GO
