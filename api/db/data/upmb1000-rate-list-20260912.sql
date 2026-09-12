/*
 * upmb1000-rate-list-20260912.sql
 *
 * A rate list of UPMB1000's own, from "UP MUJAFF RATE LIST.xlsx" (2026-09-12).
 *
 * How rates are tagged in the LIS, verified in its source and on Noble: a
 * centre (tbl_med_mcc_unit_master) carries a POINTER, RateType, to a shared
 * rate list (tbl_med_test_rate_types); the list is one price row per test,
 * profile and master profile in the three *_rates_with_pcc_type* tables;
 * a per-centre special rate (tbl_med_mcc_test_special_rates) outranks the
 * list; the catalogue MRP is the last fallback. UPMB1000 pointed at list 82
 * "UP MUJJAF", shared by 115 centres. The workbook is that list with 173
 * test prices revised; the user's decision was NOT to touch the shared
 * list but to give this one centre a list of its own.
 *
 * So: a new list "UPMB1000 RATE LIST", every row of list 82 copied into it
 * (1,832 tests, 133 profiles, 504 packages — nothing the centre could order
 * before becomes unorderable, since the LIS hides an item with no row), the
 * 173 revised test prices applied on top, and UPMB1000's RateType and
 * RateTypeBilling (both were 82) pointed at it. List 82 is not written.
 *
 * Idempotent: a second run finds the list by name and does nothing.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF EXISTS (SELECT 1 FROM dbo.tbl_med_test_rate_types WHERE Rate = N'UPMB1000 RATE LIST')
BEGIN
    PRINT 'UPMB1000 RATE LIST already exists; nothing done.';
    SELECT id, Rate FROM dbo.tbl_med_test_rate_types WHERE Rate = N'UPMB1000 RATE LIST';
    RETURN;
END

BEGIN TRANSACTION;

DECLARE @src INT = 82, @mcc INT = 6073, @new INT;

INSERT INTO dbo.tbl_med_test_rate_types (Rate, Description, IsActive)
VALUES (N'UPMB1000 RATE LIST', N'DUA COLLECTION CENTRE — from UP MUJAFF list, revised 2026-09-12', 1);
SET @new = SCOPE_IDENTITY();
PRINT CONCAT('New rate list id ', @new);

INSERT INTO dbo.tbl_med_test_rates_with_pcc_type (TestCode, RateTypeId, Price, IsActive)
SELECT TestCode, @new, Price, IsActive FROM dbo.tbl_med_test_rates_with_pcc_type WHERE RateTypeId = @src;
PRINT CONCAT('tests copied: ', @@ROWCOUNT);
INSERT INTO dbo.tbl_med_profile_rates_with_pcc_types (profilecode, RateTypeId, Price, IsActive)
SELECT profilecode, @new, Price, IsActive FROM dbo.tbl_med_profile_rates_with_pcc_types WHERE RateTypeId = @src;
PRINT CONCAT('profiles copied: ', @@ROWCOUNT);
INSERT INTO dbo.tbl_med_master_profile_rates_with_pcc_types (master_profile_code, RateTypeId, Price, IsActive)
SELECT master_profile_code, @new, Price, IsActive FROM dbo.tbl_med_master_profile_rates_with_pcc_types WHERE RateTypeId = @src;
PRINT CONCAT('packages copied: ', @@ROWCOUNT);

-- The workbook's revised test prices (173), keyed by tbl_med_test_master.id.
DECLARE @rev TABLE (test_id INT PRIMARY KEY, code NVARCHAR(50), old_price INT, new_price INT);
INSERT INTO @rev (test_id, code, old_price, new_price) VALUES
(164, N'BI214', 45, 30),
(165, N'BI215', 45, 30),
(322, N'BI003', 300, 250),
(625, N'BI033', 450, 400),
(626, N'BI034', 650, 400),
(629, N'BI036', 450, 250),
(2279, N'BI0001', 730, 500),
(2784, N'A1BAPOR', 500, 250),
(2396, N'ASPPHA', 1100, 500),
(2769, N'ASPH01', 2000, 500),
(2706, N'BIMGURN', 1500, 500),
(85, N'BI044', 200, 125),
(1944, N'BI295', 1000, 350),
(87, N'BI046', 60, 50),
(88, N'BI047', 45, 40),
(89, N'BI048', 45, 40),
(90, N'BI056', 45, 40),
(94, N'BI060', 350, 300),
(102, N'BI077', 60, 50),
(103, N'BI078', 45, 40),
(104, N'BI079', 45, 40),
(107, N'BI088', 110, 100),
(1822, N'CP00003', 0, 500),
(282, N'BI100', 110, 100),
(2087, N'BI352', 120, 100),
(120, N'BI101', 1100, 600),
(123, N'BI104', 200, 150),
(124, N'BI105', 200, 125),
(1951, N'BI302', 3800, 650),
(128, N'BI109', 55, 50),
(129, N'BI110', 55, 50),
(125, N'BI106', 90, 80),
(130, N'BI112', 55, 50),
(2799, N'BI7436', 300, 50),
(287, N'BI125', 130, 60),
(2531, N'BI0126', 300, 50),
(2532, N'BI00126', 300, 50),
(291, N'BI127', 110, 90),
(2236, N'BI00121', 600, 400),
(202, N'MS067', 250, 100),
(338, N'BI134', 1550, 1500),
(1903, N'BI282', 3200, 1800),
(134, N'BI136', 200, 150),
(2105, N'BI501', 200, 150),
(143, N'BI161', 400, 275),
(135, N'BI137', 110, 60),
(138, N'BI145', 90, 80),
(139, N'BI146', 130, 120),
(2826, N'LIBF01', 350, 150),
(241, N'BI149', 110, 100),
(272, N'BI150', 160, 100),
(141, N'BI148', 110, 100),
(47, N'BI155', 140, 100),
(80, N'B2043', 150, 100),
(1990, N'BI406', 4300, 3000),
(147, N'BI177', 1200, 900),
(2536, N'BIPHYE1', 2500, 1200),
(146, N'BI165', 110, 100),
(224, N'BI164', 160, 100),
(249, N'BI230A', 110, 100),
(150, N'BI180', 90, 80),
(692, N'BI187', 210, 100),
(2647, N'BI00012', 200, 50),
(158, N'BI209', 140, 120),
(133, N'BI133', 150, 100),
(153, N'BI186', 45, 40),
(303, N'BI219', 500, 400),
(2003, N'BI412', 500, 450),
(2765, N'TRT02', 1000, 400),
(169, N'BI220', 500, 450),
(170, N'BI221', 35, 30),
(175, N'BI235', 150, 120),
(74, N'BI005', 250, 160),
(2027, N'OT123', 1500, 500),
(2040, N'OT12', 800, 260),
(34, N'CP004', 40, 30),
(2753, N'EXENA', 3000, 2450),
(2726, N'BIFE0012', 250, 600),
(2122, N'A30AJ', 550, 250),
(15, N'HE010', 240, 200),
(233, N'HE011', 70, 50),
(263, N'HE012', 65, 60),
(72, N'HE013', 200, 125),
(267, N'HE014', 200, 125),
(255, N'HE016', 500, 450),
(678, N'HE021', 50, 40),
(720, N'HMG', 125, 120),
(2621, N'IPFC', 1000, 350),
(1842, N'HEM001', 600, 500),
(438, N'HI008', 500, 380),
(439, N'HI009', 350, 280),
(440, N'HI010', 250, 180),
(755, N'MS007', 350, 250),
(2269, N'IFAN01', 5200, 2500),
(2031, N'MS-LK46', 950, 600),
(474, N'HI001', 1800, 150),
(2341, N'IMABPA1', 10000, 1950),
(2581, N'VGNG', 3000, 1450),
(2708, N'ANACL01', 750, 150),
(757, N'MS009', 700, 450),
(2822, N'ASF01', 1500, 950),
(1860, N'CP3117', 650, 500),
(1863, N'CP3200', 650, 500),
(1837, N'CP3112', 325, 250),
(749, N'MS018', 325, 250),
(183, N'MS029', 300, 100),
(184, N'MS030', 300, 100),
(736, N'MS031', 250, 200),
(737, N'MS032', 450, 350),
(738, N'MS033', 250, 200),
(741, N'MS035', 400, 200),
(1968, N'MS-01', 450, 200),
(2718, N'IMS012', 300, 200),
(2009, N'SERO-NS01', 400, 250),
(220, N'MS034', 750, 250),
(2292, N'IM112', 2900, 2450),
(2655, N'HAVCL01', 1200, 250),
(2691, N'HAVELI', 2000, 250),
(768, N'MS056', 110, 100),
(2636, N'HBSCL', 1000, 100),
(2687, N'HBSEL01', 1000, 100),
(1949, N'HBS001', 110, 100),
(2688, N'HCV001', 1000, 200),
(2217, N'IM0178', 300, 200),
(1971, N'SEROHM01', 320, 200),
(2213, N'IMHAV001', 320, 250),
(190, N'MS048', 320, 250),
(253, N'MS049', 320, 250),
(777, N'MS055', 110, 100),
(1795, N'CP3103', 300, 150),
(1797, N'CP3105', 300, 150),
(1796, N'CP3104', 300, 150),
(1798, N'CP3106', 300, 150),
(2689, N'HIVEL', 1000, 200),
(201, N'MS066', 140, 100),
(730, N'MS073', 420, 400),
(731, N'MS075', 420, 400),
(1890, N'MS111', 130, 100),
(154, N'MS085', 130, 100),
(211, N'MS087', 300, 80),
(212, N'MS088', 300, 80),
(1850, N'MS194', 300, 60),
(1836, N'MS090', 750, 600),
(2400, N'TBS01', 3000, 2100),
(779, N'CP-P00026', 600, 500),
(2666, N'TCH10', 3000, 600),
(2606, N'VB071', 400, 200),
(216, N'MS094', 220, 200),
(2190, N'MS201', 400, 300),
(2207, N'MS2022', 400, 300),
(309, N'MS091', 900, 600),
(2206, N'CP3121', 250, 60),
(726, N'MS101', 75, 50),
(2445, N'A30A1', 4000, 1800),
(2132, N'A30AT', 3000, 2600),
(2375, N'DNGPCR', 1550, 500),
(2178, N'IM194', 3000, 2400),
(349, N'IN008', 1500, 700),
(350, N'IN009', 850, 700),
(2394, N'MBHR01', 6000, 700),
(2395, N'MBHR001', 6000, 700),
(351, N'IN011', 850, 700),
(352, N'IN012', 850, 700),
(1815, N'CP6079', 1500, 700),
(664, N'HM013', 1000, 900),
(2045, N'MB125', 1300, 550),
(2247, N'MB0004', 14400, 6500),
(1847, N'CP6081', 1650, 1400),
(1792, N'CP6075', 1650, 1300),
(358, N'IN024', 550, 500),
(1989, N'BI244A', 650, 500),
(2260, N'QM02', 1800, 900),
(1810, N'BC0002', 950, 900);

UPDATE r SET r.Price = v.new_price
FROM dbo.tbl_med_test_rates_with_pcc_type r JOIN @rev v ON v.test_id = r.TestCode
WHERE r.RateTypeId = @new;
PRINT CONCAT('revised prices applied: ', @@ROWCOUNT);

UPDATE dbo.tbl_med_mcc_unit_master
   SET RateType = @new, RateTypeBilling = @new, ModifiedBy = N'inf:jas', ModifiedDate = GETDATE()
 WHERE id = @mcc AND RateType = @src;
PRINT CONCAT('centre re-pointed: ', @@ROWCOUNT);

COMMIT TRANSACTION;

SELECT id, Rate FROM dbo.tbl_med_test_rate_types WHERE id = @new;
SELECT (SELECT COUNT(*) FROM dbo.tbl_med_test_rates_with_pcc_type WHERE RateTypeId = @new) AS tests,
       (SELECT COUNT(*) FROM dbo.tbl_med_profile_rates_with_pcc_types WHERE RateTypeId = @new) AS profiles,
       (SELECT COUNT(*) FROM dbo.tbl_med_master_profile_rates_with_pcc_types WHERE RateTypeId = @new) AS packages,
       (SELECT COUNT(*) FROM dbo.tbl_med_mcc_unit_master WHERE RateType = @new) AS centres_on_new,
       (SELECT COUNT(*) FROM dbo.tbl_med_mcc_unit_master WHERE RateType = @src) AS centres_on_82;
SELECT MCCUnitCode, RateType, RateTypeBilling FROM dbo.tbl_med_mcc_unit_master WHERE id = @mcc;
