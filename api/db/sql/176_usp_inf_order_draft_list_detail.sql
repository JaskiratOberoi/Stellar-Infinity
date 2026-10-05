/*
 * 176 — the draft queue lists what each draft holds.
 *
 * Jas (2026-10-06): the "waiting to be booked" rows showed a name, a tube
 * count and a total, which is not enough to tell two drafts apart or to
 * see that the right tube went with the right patient. The row now carries
 * the test names and the Sample IDs, read out of the stored request
 * (payload.request.items[].name, payload.request.sampleSids[].vailid) at
 * list time — the payload is the record, so nothing is stored twice.
 */
SET QUOTED_IDENTIFIER ON;
GO
CREATE OR ALTER PROCEDURE dbo.usp_inf_order_draft_list
    @user_id  INT,
    @mcc_code INT
AS
BEGIN
    SET NOCOUNT ON;
    SELECT d.id, d.mcc_code, d.patient_name, d.total, d.tubes, d.sids, d.last_error,
           d.created_at, d.updated_at,
           tests = (SELECT STRING_AGG(JSON_VALUE(i.[value], '$.name'), N', ')
                        WITHIN GROUP (ORDER BY CAST(i.[key] AS INT))
                    FROM OPENJSON(d.payload, '$.request.items') i),
           sid_list = (SELECT STRING_AGG(NULLIF(JSON_VALUE(s.[value], '$.vailid'), N''), N', ')
                           WITHIN GROUP (ORDER BY CAST(s.[key] AS INT))
                       FROM OPENJSON(d.payload, '$.request.sampleSids') s)
    FROM dbo.inf_order_draft d
    WHERE d.user_id = @user_id AND d.mcc_code = @mcc_code
    ORDER BY d.id;
END
GO
