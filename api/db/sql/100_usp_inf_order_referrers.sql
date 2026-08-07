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
 * NOT filtered on IsActive, deliberately. Telo filtered its client codes that
 * way and it "hid half the network" (see its commit 10424fa); the same table
 * hygiene applies here. A referrer that is inactive today still names the
 * doctor who sent last week's patient, and the create procedure is what decides
 * whether a NEW order may cite one.
 *
 * Reference data — not scoped by client code. Referrers are shared across the
 * network, and the order itself is scoped by the mcc the operator picked.
 *
 * Read-only.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_order_referrers
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
    ORDER BY d.doctor_name;

    -- 2. customers
    SELECT
        c.id,
        LTRIM(RTRIM(ISNULL(c.customer_code, ''))) AS code,
        LTRIM(RTRIM(ISNULL(c.customer_name, ''))) AS name
    FROM dbo.tbl_med_mcc_customer c
    WHERE ISNULL(c.customer_name, '') <> ''
    ORDER BY c.customer_name;
END
GO
