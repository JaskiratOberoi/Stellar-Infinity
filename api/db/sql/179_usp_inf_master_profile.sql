/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 179_usp_inf_master_profile.sql — Master Profiles (packages), authored from
 * Infinity. The port of the legacy Technical > Master Profile page
 * (MasterProfile_Master.aspx / MasterProfileClass.cs), on Jas's instruction
 * of 2026-10-07.
 *
 * The SHARED catalogue tables are written, exactly as the LIS writes them,
 * because a package the LIS cannot see is not a package:
 *
 *   tbl_med_test_master_profile_master   the package: code, name, CT, MRP,
 *                                        IsActive
 *   tbl_med_test_master_profile_param    its member PROFILES (profileid +
 *                                        a snapshot of the profile's name)
 *   tbl_med_test_master_test_param       its member TESTS (testid + name)
 *   tbl_med_master_profile_rates_with_pcc_types
 *                                        a NEW package gets one row per rate
 *                                        type at its MRP, as the LIS inserts
 *                                        on create (never touched on edit)
 *
 * What the LIS does that is kept to the letter: code must be unique; members
 * are replaced wholesale on every save; member names are stored as typed at
 * save time (the order procs and the report read those snapshots); the rate
 * rows seed at MRP on create only. What is tightened: a package that has
 * ever been ordered, or that the Smart Report is sold with, cannot be
 * deleted (the LIS deletes the header and the profile members and leaves
 * the test members and the rates orphaned); a delete here removes every
 * row of the package. CreatedBy/ModifiedBy are stamped ('inf:<userId>'); the
 * LIS leaves them NULL.
 *
 * Procedures:
 *   usp_inf_master_profile_list    @search, @page, @page_size
 *   usp_inf_master_profile_get     @id
 *   usp_inf_master_profile_save    @id (NULL = new), @code, @name, @ct, @mrp,
 *                                  @is_active, @members JSON, @by
 *   usp_inf_master_profile_set_active @id, @active, @by
 *   usp_inf_master_profile_delete  @id
 *   usp_inf_master_profile_picker  @kind ('profile' | 'test'), @search
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_master_profile_list
    @search    NVARCHAR(100) = NULL,
    @page      INT = 1,
    @page_size INT = 50
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @q NVARCHAR(100) = NULLIF(LTRIM(RTRIM(@search)), N'');
    IF @page < 1 SET @page = 1;
    IF @page_size < 1 OR @page_size > 500 SET @page_size = 50;

    ;WITH hits AS (
        SELECT m.id
        FROM dbo.tbl_med_test_master_profile_master m
        WHERE @q IS NULL OR m.Master_Profile_Code LIKE N'%' + @q + N'%' OR m.Master_Profile_Name LIKE N'%' + @q + N'%'
    )
    SELECT m.id,
           code          = m.Master_Profile_Code,
           name          = m.Master_Profile_Name,
           ct            = m.CT,
           mrp           = m.MRP,
           is_active     = ISNULL(m.IsActive, 0),
           profile_count = (SELECT COUNT(*) FROM dbo.tbl_med_test_master_profile_param p WHERE p.master_profileid = m.id),
           test_count    = (SELECT COUNT(*) FROM dbo.tbl_med_test_master_test_param t WHERE t.master_profileid = m.id),
           -- The members' names in the LIS's own order (profiles, then tests)
           -- for the row's summary line.
           members       = STUFF((
                               SELECT N', ' + x.nm FROM (
                                   SELECT 1 AS k, p.profileid AS i, p.profile_name AS nm
                                   FROM dbo.tbl_med_test_master_profile_param p WHERE p.master_profileid = m.id
                                   UNION ALL
                                   SELECT 2, t.testid, t.test_name
                                   FROM dbo.tbl_med_test_master_test_param t WHERE t.master_profileid = m.id
                               ) x ORDER BY x.k, x.i
                               FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, N''),
           created_by    = m.CreatedBy,
           created_date  = m.CreatedDate,
           modified_by   = m.ModifiedBy,
           modified_date = m.ModifiedDate,
           total         = (SELECT COUNT(*) FROM hits)
    FROM dbo.tbl_med_test_master_profile_master m
    WHERE m.id IN (SELECT id FROM hits)
    ORDER BY m.Master_Profile_Code, m.Master_Profile_Name, m.id
    OFFSET (@page - 1) * @page_size ROWS FETCH NEXT @page_size ROWS ONLY;
END
GO

CREATE OR ALTER PROCEDURE dbo.usp_inf_master_profile_get
    @id INT
AS
BEGIN
    SET NOCOUNT ON;
    SELECT m.id,
           code          = m.Master_Profile_Code,
           name          = m.Master_Profile_Name,
           ct            = m.CT,
           mrp           = m.MRP,
           is_active     = ISNULL(m.IsActive, 0),
           created_by    = m.CreatedBy,
           created_date  = m.CreatedDate,
           modified_by   = m.ModifiedBy,
           modified_date = m.ModifiedDate,
           ordered_count = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_tests o
                            WHERE o.test_type = N'Master' AND o.test_id = m.id),
           smart_report  = CASE WHEN EXISTS (SELECT 1 FROM dbo.inf_smart_report_package s WHERE s.master_profile_id = m.id)
                                THEN 1 ELSE 0 END
    FROM dbo.tbl_med_test_master_profile_master m
    WHERE m.id = @id;

    -- The members, in the LIS's order: profiles by id, then tests by id.
    -- `name` is the stored snapshot; `current_name` is what the catalogue
    -- calls it now, so a renamed member shows both.
    SELECT kind = N'profile', id = p.profileid, snapshot_name = p.profile_name,
           code = pm.Profile_Code, current_name = pm.Profile_Name, mrp = pm.MRP,
           is_active = ISNULL(pm.IsActive, 0), exists_now = CASE WHEN pm.id IS NULL THEN 0 ELSE 1 END
    FROM dbo.tbl_med_test_master_profile_param p
    LEFT JOIN dbo.tbl_med_test_profile_master pm ON pm.id = p.profileid
    WHERE p.master_profileid = @id
    UNION ALL
    SELECT N'test', t.testid, t.test_name,
           tm.TestCode, tm.Testname, tm.MRP,
           ISNULL(tm.IsActive, 0), CASE WHEN tm.id IS NULL THEN 0 ELSE 1 END
    FROM dbo.tbl_med_test_master_test_param t
    LEFT JOIN dbo.tbl_med_test_master tm ON tm.id = t.testid
    WHERE t.master_profileid = @id
    ORDER BY kind DESC, id;   -- 'profile' sorts after 'test' ascending; DESC puts profiles first
END
GO

CREATE OR ALTER PROCEDURE dbo.usp_inf_master_profile_save
    @id        INT = NULL,
    @code      NVARCHAR(100),
    @name      NVARCHAR(400),
    @ct        INT = NULL,
    @mrp       INT = NULL,
    @is_active BIT = 1,
    @members   NVARCHAR(MAX) = N'[]',   -- [{"kind":"profile"|"test","id":123}, ...]
    @by        NVARCHAR(100) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    SET @code = NULLIF(LTRIM(RTRIM(@code)), N'');
    SET @name = NULLIF(LTRIM(RTRIM(@name)), N'');
    IF @code IS NULL
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION', message = N'A package needs a code.', id = CAST(NULL AS INT);
        RETURN;
    END
    IF @name IS NULL
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION', message = N'A package needs a name.', id = CAST(NULL AS INT);
        RETURN;
    END
    IF @ct IS NOT NULL AND @ct < 0 OR @mrp IS NOT NULL AND @mrp < 0
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION', message = N'CT and MRP cannot be negative.', id = CAST(NULL AS INT);
        RETURN;
    END
    IF @id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_test_master_profile_master WHERE id = @id)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'NOT_FOUND', message = N'That package no longer exists.', id = CAST(NULL AS INT);
        RETURN;
    END
    -- The LIS's CheckProfileCode: the code is unique across the catalogue.
    IF EXISTS (SELECT 1 FROM dbo.tbl_med_test_master_profile_master
               WHERE Master_Profile_Code = @code AND (@id IS NULL OR id <> @id))
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'DUPLICATE_CODE', message = N'Master Profile code ' + @code + N' already exists.', id = CAST(NULL AS INT);
        RETURN;
    END
    IF @members IS NULL OR ISJSON(@members) = 0
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION', message = N'The member list could not be read.', id = CAST(NULL AS INT);
        RETURN;
    END

    DECLARE @m TABLE (kind NVARCHAR(10), id INT, PRIMARY KEY (kind, id));
    INSERT INTO @m (kind, id)
    SELECT DISTINCT LOWER(kind), id
    FROM OPENJSON(@members) WITH (kind NVARCHAR(10) '$.kind', id INT '$.id')
    WHERE id IS NOT NULL AND LOWER(kind) IN (N'profile', N'test');

    -- Every member must be a real catalogue row; a dangling id would be an
    -- order line the report cannot name.
    IF EXISTS (SELECT 1 FROM @m x WHERE x.kind = N'profile' AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_test_profile_master p WHERE p.id = x.id))
       OR EXISTS (SELECT 1 FROM @m x WHERE x.kind = N'test' AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_test_master t WHERE t.id = x.id))
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION', message = N'A member is not in the catalogue any more — reload and try again.', id = CAST(NULL AS INT);
        RETURN;
    END

    DECLARE @now DATETIME = GETDATE();
    DECLARE @is_new BIT = CASE WHEN @id IS NULL THEN 1 ELSE 0 END;

    BEGIN TRAN;

    IF @is_new = 1
    BEGIN
        INSERT INTO dbo.tbl_med_test_master_profile_master
            (Master_Profile_Code, Master_Profile_Name, CT, MRP, IsActive, CreatedBy, CreatedDate)
        VALUES (@code, @name, @ct, @mrp, @is_active, @by, @now);
        SET @id = SCOPE_IDENTITY();
    END
    ELSE
    BEGIN
        UPDATE dbo.tbl_med_test_master_profile_master
        SET Master_Profile_Code = @code, Master_Profile_Name = @name, CT = @ct, MRP = @mrp,
            IsActive = @is_active, ModifiedBy = @by, ModifiedDate = @now
        WHERE id = @id;
    END

    -- Members: replaced wholesale, as the LIS does. Names are snapshotted
    -- from the catalogue at save time, which is what every reader expects.
    DELETE FROM dbo.tbl_med_test_master_profile_param WHERE master_profileid = @id;
    DELETE FROM dbo.tbl_med_test_master_test_param    WHERE master_profileid = @id;

    INSERT INTO dbo.tbl_med_test_master_profile_param (master_profileid, profileid, profile_name, createddate, createdby)
    SELECT @id, p.id, p.Profile_Name, @now, @by
    FROM @m x JOIN dbo.tbl_med_test_profile_master p ON p.id = x.id
    WHERE x.kind = N'profile'
    ORDER BY p.id;

    INSERT INTO dbo.tbl_med_test_master_test_param (master_profileid, testid, test_name, createddate, createdby)
    SELECT @id, t.id, t.Testname, @now, @by
    FROM @m x JOIN dbo.tbl_med_test_master t ON t.id = x.id
    WHERE x.kind = N'test'
    ORDER BY t.id;

    -- A NEW package is priced at its MRP on every rate list, as the LIS
    -- seeds it; the Rates screen revises from there. An edit never touches
    -- the rate rows.
    IF @is_new = 1
    BEGIN
        INSERT INTO dbo.tbl_med_master_profile_rates_with_pcc_types (master_profile_code, RateTypeId, Price, IsActive)
        SELECT @id, rt.id, @mrp, 1
        FROM dbo.tbl_med_test_rate_types rt
        WHERE NOT EXISTS (SELECT 1 FROM dbo.tbl_med_master_profile_rates_with_pcc_types r
                          WHERE r.master_profile_code = @id AND r.RateTypeId = rt.id);
    END

    COMMIT;

    SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)), message = CAST(NULL AS NVARCHAR(200)), id = @id;
END
GO

CREATE OR ALTER PROCEDURE dbo.usp_inf_master_profile_set_active
    @id     INT,
    @active BIT,
    @by     NVARCHAR(100) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE dbo.tbl_med_test_master_profile_master
    SET IsActive = @active, ModifiedBy = @by, ModifiedDate = GETDATE()
    WHERE id = @id;
    SELECT ok = CAST(CASE WHEN @@ROWCOUNT > 0 THEN 1 ELSE 0 END AS BIT);
END
GO

CREATE OR ALTER PROCEDURE dbo.usp_inf_master_profile_delete
    @id INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_test_master_profile_master WHERE id = @id)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'NOT_FOUND', message = N'That package no longer exists.';
        RETURN;
    END
    DECLARE @orders INT = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_tests WHERE test_type = N'Master' AND test_id = @id);
    IF @orders > 0
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'ORDERED',
               message = N'This package is on ' + CAST(@orders AS NVARCHAR(12)) + N' order line(s) and cannot be deleted — switch it off instead.';
        RETURN;
    END
    IF EXISTS (SELECT 1 FROM dbo.inf_smart_report_package WHERE master_profile_id = @id)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'SMART_REPORT',
               message = N'The Smart Report is sold with this package; remove it from that list first.';
        RETURN;
    END

    BEGIN TRAN;
    DELETE FROM dbo.tbl_med_test_master_profile_param WHERE master_profileid = @id;
    DELETE FROM dbo.tbl_med_test_master_test_param    WHERE master_profileid = @id;
    DELETE FROM dbo.tbl_med_master_profile_rates_with_pcc_types WHERE master_profile_code = @id;
    DELETE FROM dbo.tbl_med_mcc_test_special_rates WHERE testtype = N'M' AND testid = @id;
    DELETE FROM dbo.tbl_med_test_master_profile_master WHERE id = @id;
    COMMIT;

    SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)), message = CAST(NULL AS NVARCHAR(200));
END
GO

/* The picker: the active profiles or the active tests, as the LIS's two
   radio lists offer them (the LIS lists ALL profiles for the "Profiles"
   radio and active ones for the search; active only here, since an
   inactive member is one the order expansion ignores anyway). */
CREATE OR ALTER PROCEDURE dbo.usp_inf_master_profile_picker
    @kind   NVARCHAR(10),
    @search NVARCHAR(100) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @q NVARCHAR(100) = NULLIF(LTRIM(RTRIM(@search)), N'');
    IF LOWER(@kind) = N'profile'
        SELECT TOP 400 id, code = Profile_Code, name = Profile_Name, mrp = MRP, department_id
        FROM dbo.tbl_med_test_profile_master
        WHERE IsActive = 1 AND (@q IS NULL OR Profile_Code LIKE N'%' + @q + N'%' OR Profile_Name LIKE N'%' + @q + N'%')
        ORDER BY Profile_Name;
    ELSE
        SELECT TOP 400 id, code = TestCode, name = Testname, mrp = MRP, department_id = DepartmentId
        FROM dbo.tbl_med_test_master
        WHERE IsActive = 1 AND (@q IS NULL OR TestCode LIKE N'%' + @q + N'%' OR Testname LIKE N'%' + @q + N'%')
        ORDER BY Testname;
END
GO
