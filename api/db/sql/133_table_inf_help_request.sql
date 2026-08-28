/*
 * 133_table_inf_help_request.sql — help requests, built PROPERLY.
 *
 * The LIS's HRF stores tickets inside tbl_technical_dc_reconstitutional — a
 * reagent reconstitution table — with the category smuggled into a "T|"/"G|"
 * prefix on control_name, the centre id in number_of_vails and the user id in
 * number_of_vails_remaining. Seventeen tickets this year travelled through
 * that. Compatibility with a column-abuse hack nobody depends on is not worth
 * preserving; this is the one half of the client-request pair that gets a
 * clean Infinity table. (MRF is the opposite case — live and lab-processed —
 * and stays in the LIS's own tables; see 132.)
 */
IF OBJECT_ID('dbo.inf_help_request', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_help_request (
        id          INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_inf_help_request PRIMARY KEY,
        mcc         INT           NOT NULL,
        user_id     INT           NOT NULL,
        category    VARCHAR(20)   NOT NULL
            CONSTRAINT CK_inf_help_request_category CHECK (category IN ('technical', 'general')),
        subject     NVARCHAR(200) NOT NULL,
        detail      NVARCHAR(2000) NULL,
        status      VARCHAR(20)   NOT NULL
            CONSTRAINT DF_inf_help_request_status DEFAULT 'open'
            CONSTRAINT CK_inf_help_request_status CHECK (status IN ('open', 'in_progress', 'closed')),
        /* The lab's answer, shown to the client verbatim. */
        response     NVARCHAR(2000) NULL,
        responded_by INT            NULL,
        created_at  DATETIME2(0)  NOT NULL CONSTRAINT DF_inf_help_request_created DEFAULT SYSDATETIME(),
        updated_at  DATETIME2(0)  NOT NULL CONSTRAINT DF_inf_help_request_updated DEFAULT SYSDATETIME()
    );

    CREATE NONCLUSTERED INDEX IX_inf_help_request_mcc ON dbo.inf_help_request (mcc, created_at DESC);
    CREATE NONCLUSTERED INDEX IX_inf_help_request_open ON dbo.inf_help_request (status) WHERE status <> 'closed';
END
