/*
 * up0801-rate-list-20260930.sql
 *
 * A rate list of UP0801's own (unit 6040, NOBLE MBD CC), from
 * "NOBEL PRICE LIST 2026-27.xlsx" (2026-09-30), built the way UPMB1000's was
 * (upmb1000-rate-list-20260912.sql): a new list, every row of list 82
 * "UP MUJJAF" (shared by 127 centres, not written) copied into it, the
 * workbook's prices applied on top, and the centre's RateType and
 * RateTypeBilling (both 82) pointed at it.
 *
 * The workbook carries NO test codes on its 709 main rows, so only the rows
 * that matched one catalogue item without doubt are applied here — 163
 * of 721 (Jas, 2026-09-30: "apply the confident rows now"). The rest stay
 * at list 82's prices until their codes are settled; see the review sheet
 * UP0801-rate-list-review-20260930.xlsx.
 *
 * UP0801 has special rates of its own (tbl_med_mcc_test_special_rates), which
 * outrank any list; the ones the workbook revises are updated too, so the
 * new price is the one that resolves.
 *
 * Idempotent: a second run finds the list by name and does nothing.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF EXISTS (SELECT 1 FROM dbo.tbl_med_test_rate_types WHERE Rate = N'UP0801 RATE LIST')
BEGIN
    PRINT 'UP0801 RATE LIST already exists; nothing done.';
    SELECT id, Rate FROM dbo.tbl_med_test_rate_types WHERE Rate = N'UP0801 RATE LIST';
    RETURN;
END

BEGIN TRANSACTION;

DECLARE @src INT = 82, @mcc INT = 6040, @new INT;
IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_unit_master WHERE id = @mcc AND LTRIM(RTRIM(MCCUnitCode)) = 'UP0801' AND RateType = @src)
    THROW 50000, 'UP0801 (6040) is not on list 82 any more; stop.', 1;

INSERT INTO dbo.tbl_med_test_rate_types (Rate, Description, IsActive)
VALUES (N'UP0801 RATE LIST', N'NOBLE MBD CC — from UP MUJJAF list, NOBEL PRICE LIST 2026-27 applied 2026-09-30', 1);
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

-- The workbook's prices, keyed by catalogue id (old = list 82's price, sno = workbook row).
DECLARE @t TABLE (id INT PRIMARY KEY, code NVARCHAR(50), name NVARCHAR(80), old_price INT NULL, new_price INT, sno INT NULL);
INSERT INTO @t (id, code, name, old_price, new_price, sno) VALUES
(642, N'HE001', N'Absolute Eosinophil Count', 50, 40, 6),
(643, N'HE002', N'Absolute Lymphocyte Count', 50, 40, 7),
(644, N'HE003', N'Absolute Neutrophil Count', 50, 40, 8),
(1986, N'BI401', N'ADA (Adenosine Deaminase)', 150, 100, 16),
(18, N'BI012', N'ADA (Adenosine Deaminase) CSF', 150, 110, 17),
(227, N'BI013', N'Adreno Corticotrophic Hormone (ACTH)', 800, 550, 22),
(264, N'BI019', N'Albumin - Serum', 50, 40, 29),
(2066, N'BI346', N'ALCOHOL SERUM', 900, 500, 33),
(256, N'BI021', N'ALDOLASE', 400, 280, 35),
(270, N'BI022', N'Aldosterone', 800, 800, 36),
(279, N'BI023', N'Alkaline Phosphatase (ALP)', 50, 40, 37),
(1808, N'BI024', N'AFP  Alpha Feto Protein Serum', 200, 180, 40),
(685, N'BI027', N'AMMONIA - PLASMA', 550, 300, 43),
(623, N'BI031', N'Amylase', 100, 90, 44),
(625, N'BI033', N'Angiotensin Converting Enzyme (ACE)', 450, 300, 50),
(2074, N'MI129', N'Anti JO-1 Antibody', 650, 670, 56),
(631, N'BI038', N'Apolipoprotein A1 (Apo-A1)', 220, 200, 79),
(689, N'BI039', N'Apolipoprotein B (Apo-B)', 220, 200, 80),
(2743, N'ARS1', N'Arsenic', 5000, 1680, 82),
(81, N'BI040', N'Aspartate Aminotransferase (AST/SGOT)', 50, 40, 87),
(2706, N'BIMGURN', N'BETA 2 Microglobulin, Urine', 1500, 550, 95),
(2222, N'BI1003', N'BETA 2 Glycoprotein IgA', 350, 380, 102),
(89, N'BI048', N'Bilirubin Total', 45, 40, 109),
(2212, N'MBBK001', N'BK VIRUS (BK Polyoma virus) PCR - Qualitative', 2500, 3000, 110),
(2, N'HE005', N'Bleeding Time', 75, 60, 111),
(90, N'BI056', N'Blood Urea Nitrogen (BUN)', 45, 40, 114),
(3, N'HE0007', N'Bone Marrow Smear Examination', 1500, 300, 116),
(1845, N'CP3113', N'Brucella - IgM', 400, 380, 119),
(96, N'BI064', N'Calcium - Serum', 50, 40, 126),
(99, N'BI068', N'CEA - Carcino embryonic antigen (Serum)', 200, 200, 131),
(746, N'MS014', N'Cardiolipin Anti body - IgA', 150, 180, 133),
(747, N'MS016', N'Cardiolipin Anti body - IgG', 250, 180, 134),
(748, N'MS017', N'Cardiolipin Antibody - IgM', 250, 180, 135),
(2232, N'CD0001', N'CD3/CD4/CD8', 425, 500, 158),
(100, N'BI069', N'Ceruloplasmin - Serum', 300, 370, 177),
(21, N'BI071', N'Chloride - CSF', 80, 60, 182),
(101, N'BI074', N'Chloride', 60, 60, 183),
(102, N'BI077', N'Cholesterol - HDL', 60, 60, 185),
(103, N'BI078', N'Cholesterol - LDL', 45, 60, 186),
(104, N'BI079', N'Cholesterol - Total', 45, 40, 187),
(105, N'BI080', N'Cholinesterase', 250, 300, 188),
(233, N'HE011', N'Complete Blood Count (CBC)', 70, 60, 203),
(72, N'HE013', N'Coombs Test - Direct', 200, 100, 205),
(267, N'HE014', N'Coombs Test - Indirect', 200, 100, 206),
(110, N'BI084', N'Copper-Serum', 300, 300, 207),
(2137, N'bi421', N'Urine Copper', 250, 300, 208),
(112, N'BI086', N'C-Peptide', 500, 280, 212),
(113, N'MS024', N'C-Reactive Protein (CRP)', 100, 80, 213),
(114, N'BI089', N'Creatinine', 50, 40, 215),
(698, N'MB034', N'URINE FOR CULTURE AND SENSITIVITY', 100, 80, 220),
(265, N'BI094', N'CYCLOSPORINE - WHOLE BLOOD', 1920, 1750, 235),
(1861, N'BI265', N'CYFRA 21-1 LUNG CANCER MARKER SERUM', 1200, 1440, 236),
(115, N'BI095', N'Cystatin- C', 750, 650, 237),
(255, N'HE016', N'D-Dimer', 500, 300, 245),
(116, N'BI096', N'Dehydroepiandrosterone (Dhea)', 300, 800, 246),
(741, N'MS035', N'Dengue - NS1 Antigen', 400, 250, 248),
(736, N'MS031', N'Dengue - IgG', 250, 220, 250),
(738, N'MS033', N'Dengue - IgM', 250, 220, 251),
(118, N'BI098', N'Digoxin', 450, 500, 256),
(185, N'MS038', N'Echinococcus Antibody-IgG (Hydatid serology)', 450, 450, 261),
(2225, N'IM110036', N'Endomysial Antibody IgA', 800, 960, 263),
(2070, N'HE068', N'Erythrocyte Count (RBC Count)', 50, 50, 268),
(268, N'HE017', N'Erythrocyte Sedimentation Rate (ESR)', 40, 20, 269),
(120, N'BI101', N'Erythropoietin (EPO)', 1100, 650, 270),
(121, N'BI102', N'Estradiol (E2)', 150, 120, 271),
(122, N'BI103', N'Estriol Unconjugated (E3)', 220, 200, 273),
(674, N'HS001', N'FACTOR II (PROTHROMBIN) Mutation Study', 2600, 3000, 275),
(2011, N'HE047', N'Factor - VIII', 520, 600, 279),
(277, N'HE018', N'Fibrinogen', 300, 300, 281),
(2408, N'CLLFS1', N'CLL PANEL BY FISH', 10000, 10200, 283),
(2373, N'CGBCR01', N'BCR- ABL FISH', 4900, 3840, 284),
(2616, N'FL0012', N'MULTIPLE MYELOMA BY FISH', 23000, 13800, 300),
(125, N'BI106', N'FSH Follicle Stimulating Hormone', 90, 70, 310),
(1951, N'BI302', N'FREE LIGHT CHAINS KAPPA & LAMBDA', 3800, 4800, 313),
(283, N'BI111', N'Fructosamine', 550, 300, 314),
(130, N'BI112', N'Gamma Glutamyl Transferase (GGT)', 55, 50, 317),
(131, N'BI113', N'Gastrin', 800, 650, 319),
(722, N'BI253', N'Globulin', 55, 50, 324),
(284, N'BI114', N'Glucose - Fasting', 20, 20, 326),
(286, N'BI116', N'Glucose - Random', 20, 20, 328),
(290, N'BI124', N'Glucose 6 Phosphate Dehydrogenase (G6PD Quantitative)', 250, 230, 329),
(430, N'MB046', N'Gram''s Stain', 50, 50, 334),
(132, N'BI128', N'Growth Hormone (HGH)', 180, 200, 335),
(2220, N'HPIGA01', N'Helicobacter Pylori - IgA (H.Pylori - IgA )', 400, 450, 338),
(188, N'MS046', N'Helicobacter Pylori - IgG (H.Pylori - IgG )', 400, 450, 339),
(180, N'MS047', N'Helicobacter Pylori - IgM (H.Pylori - IgM )', 400, 450, 340),
(2213, N'IMHAV001', N'Hepatitis A virus - IgG (HAV Ab-IgG)', 320, 270, 343),
(192, N'MS053', N'Hepatitis B Envelope Antigen (HBeAg)', 230, 200, 346),
(196, N'MS050', N'Hepatitis B Core Anti body - IgM (Anti HBC-IgM)', 225, 160, 359),
(200, N'MS099', N'Western Blot for HIV I&2', 800, 1100, 374),
(228, N'BI132', N'Homocysteine', 400, 280, 379),
(203, N'MS069', N'Immunoglobulin A - IgA', 175, 140, 432),
(134, N'BI136', N'Insulin Fasting', 200, 140, 437),
(2268, N'BII01', N'IGF BP3 (Insulin Like Growth Factor Binding Protein 3)', 1550, 1200, 438),
(2214, N'CPI0001', N'Iodine, Serum', 850, 1020, 443),
(97, N'BI063', N'Calcium - ionized', 200, 120, 444),
(661, N'HM018', N'Imatinib Resistance Mutation Analysis (IRMA)', 9600, 7200, 445),
(135, N'BI137', N'Iron', 110, 60, 446),
(136, N'BI138', N'Iron Binding Capacity - Total (TIBC)', 110, 70, 447),
(1993, N'BI322', N'Islet Cell Antibody', 1400, 1440, 448),
(289, N'BI139', N'LACTATE - PLASMA', 320, 300, 454),
(1934, N'HE007', N'LE Cells', 120, 110, 462),
(296, N'BI144', N'Lead', 800, 800, 463),
(2416, N'LEPPCR1', N'LEPTOSPIRA DNA PCR QUALITATIVE', 4000, 1440, 468),
(139, N'BI146', N'Lipase', 130, 90, 471),
(140, N'BI147', N'Lipoprotein a (Lp-a)', 300, 300, 472),
(1794, N'CP3102', N'Liver Kidney Microsome Anti body  (LKM Ab) - ELISA', 600, 600, 474),
(141, N'BI148', N'Magnesium- Serum', 110, 120, 477),
(2229, N'BI0080', N'Mercury, Whole Blood', 2000, 2400, 486),
(2049, N'HE067', N'Microfilaria antigen', 300, 270, 491),
(344, N'MB050', N'Mantoux test', 200, 120, 494),
(2093, N'BI364', N'MYOGLOBIN SERUM', 1500, 1800, 511),
(243, N'BI160', N'Urine Osmolality', 200, 240, 530),
(142, N'BI159', N'Serum Osmolality', 200, 240, 531),
(1817, N'BI243', N'PAPP - A', 600, 480, 534),
(145, N'BI163', N'Phenytoin (Eptoin)', 250, 250, 546),
(617, N'HE029', N'Platelet Count', 50, 60, 550),
(297, N'BI174', N'Potassium', 110, 50, 556),
(149, N'BI179', N'Progesterone', 110, 110, 562),
(150, N'BI180', N'Prolactin- Serum', 90, 70, 563),
(152, N'BI183', N'Protein Electrophoresis- Serum', 350, 250, 570),
(300, N'BI184A', N'Protein Electrophoresis (Urine)', 350, 300, 571),
(153, N'BI186', N'Total Protein', 45, 40, 573),
(292, N'BI197', N'RBC Folate', 950, 840, 579),
(229, N'BI198', N'Plasma Renin Activity', 2500, 3000, 580),
(425, N'HI129', N'Reticulin Stain', 250, 230, 581),
(619, N'HE031', N'Reticulocyte Count', 100, 70, 582),
(64, N'CP007', N'Semen Analysis', 150, 50, 594),
(2167, N'CP0124', N'Fructose Semen', 100, 120, 595),
(156, N'BI200', N'Sex Hormone Binding Globulin (SHBG)', 190, 180, 596),
(620, N'HE032', N'Sickling test', 130, 80, 598),
(2143, N'IM031', N'RNP-Sm Antibody', 700, 700, 600),
(157, N'BI205', N'Sodium', 50, 60, 602),
(246, N'BI206', N'SODIUM - SPOT URINE', 60, 60, 603),
(1849, N'BI560', N'STONE FOR ANALYSIS', 300, 250, 605),
(67, N'CP008', N'Stool - Occult Blood /FOBT', 70, 50, 608),
(340, N'BI207', N'Tacrolimus- Whole Blood', 3000, 1700, 612),
(159, N'BI208', N'Testosterone - Free', 250, 280, 616),
(158, N'BI209', N'Testosterone  - Total', 140, 120, 617),
(2327, N'TATG', N'Tetanus IgG', 2500, 1980, 618),
(621, N'HE033', N'Thrombin Time', 120, 120, 619),
(170, N'BI221', N'TSH : Thyroid Stimulating Hormone', 35, 30, 621),
(133, N'BI133', N'Total IgE', 150, 120, 634),
(1966, N'MB01', N'Toxoplasma DNA PCR', 1500, 1800, 635),
(166, N'BI216', N'Transferrin', 400, 380, 639),
(1947, N'BI300', N'TSH Receptor antibodies', 1650, 1600, 646),
(172, N'BI224', N'Urea', 50, 40, 649),
(173, N'BI227', N'Uric acid', 50, 40, 651),
(40, N'CP014', N'Urine - Hemosiderin', 200, 240, 656),
(175, N'BI235', N'Vitamin B12  -Serum', 150, 120, 663),
(1856, N'BI409', N'Vitamin B6', 2000, 2520, 664),
(176, N'BI236', N'Vitamin - E (Tocopherol)', 1800, 2160, 665),
(304, N'BI239', N'VMA (Vanillyl Mandelic Acid)-24hr Urine', 1200, 1440, 666),
(1820, N'CP3111', N'Weil Felix', 300, 360, 668),
(1868, N'BI268', N'Zinc', 400, 480, 673),
(1935, N'ALD1', N'Allergy Panel - Drugs', 950, 900, 676),
(1818, N'BI244', N'Free Beta HCG', 300, 180, NULL);
DECLARE @p TABLE (id INT PRIMARY KEY, code NVARCHAR(50), name NVARCHAR(80), old_price INT NULL, new_price INT, sno INT NULL);
-- (no profiles)
DECLARE @m TABLE (id INT PRIMARY KEY, code NVARCHAR(50), name NVARCHAR(80), old_price INT NULL, new_price INT, sno INT NULL);
INSERT INTO @m (id, code, name, old_price, new_price, sno) VALUES
(209, N'P035A', N'P035A HEALTH CARE PROFILE 1.1', 250, 220, NULL),
(210, N'P036A', N'P036A HEALTH CARE PROFILE 1.2', 350, 300, NULL),
(211, N'P037A', N'P037A HEALTH CARE PROFILE 1.3', 550, 550, NULL),
(216, N'P038A', N'P038A HEALTH CARE PROFILE 1.4', 600, 600, NULL),
(2494, N'P034', N'P034 HEALTH PROFILE', 550, 500, NULL),
(215, N'P042', N'P042 GENOMICS HEALTH PACKAGE', 200, 180, NULL);

UPDATE r SET r.Price = v.new_price, r.IsActive = 1
FROM dbo.tbl_med_test_rates_with_pcc_type r JOIN @t v ON v.id = r.TestCode WHERE r.RateTypeId = @new;
PRINT CONCAT('test prices applied: ', @@ROWCOUNT);
INSERT INTO dbo.tbl_med_test_rates_with_pcc_type (TestCode, RateTypeId, Price, IsActive)
SELECT v.id, @new, v.new_price, 1 FROM @t v
WHERE NOT EXISTS (SELECT 1 FROM dbo.tbl_med_test_rates_with_pcc_type r WHERE r.RateTypeId = @new AND r.TestCode = v.id);
PRINT CONCAT('test prices added (not on list 82): ', @@ROWCOUNT);
UPDATE r SET r.Price = v.new_price, r.IsActive = 1
FROM dbo.tbl_med_profile_rates_with_pcc_types r JOIN @p v ON v.id = r.profilecode WHERE r.RateTypeId = @new;
PRINT CONCAT('profile prices applied: ', @@ROWCOUNT);
INSERT INTO dbo.tbl_med_profile_rates_with_pcc_types (profilecode, RateTypeId, Price, IsActive)
SELECT v.id, @new, v.new_price, 1 FROM @p v
WHERE NOT EXISTS (SELECT 1 FROM dbo.tbl_med_profile_rates_with_pcc_types r WHERE r.RateTypeId = @new AND r.profilecode = v.id);
PRINT CONCAT('profile prices added: ', @@ROWCOUNT);
UPDATE r SET r.Price = v.new_price, r.IsActive = 1
FROM dbo.tbl_med_master_profile_rates_with_pcc_types r JOIN @m v ON v.id = r.master_profile_code WHERE r.RateTypeId = @new;
PRINT CONCAT('package prices applied: ', @@ROWCOUNT);
INSERT INTO dbo.tbl_med_master_profile_rates_with_pcc_types (master_profile_code, RateTypeId, Price, IsActive)
SELECT v.id, @new, v.new_price, 1 FROM @m v
WHERE NOT EXISTS (SELECT 1 FROM dbo.tbl_med_master_profile_rates_with_pcc_types r WHERE r.RateTypeId = @new AND r.master_profile_code = v.id);
PRINT CONCAT('package prices added: ', @@ROWCOUNT);

-- UP0801's own special rates the workbook revises (a special outranks the list).
DECLARE @s TABLE (testtype CHAR(1), id INT, code NVARCHAR(50), old_rate INT, new_rate INT);
INSERT INTO @s (testtype, id, code, old_rate, new_rate) VALUES
(N'M', 209, N'P035A', 250, 220),
(N'M', 210, N'P036A', 350, 300),
(N'M', 211, N'P037A', 550, 550),
(N'M', 216, N'P038A', 600, 600),
(N'M', 215, N'P042', 200, 180);
UPDATE sr SET sr.rate = v.new_rate
FROM dbo.tbl_med_mcc_test_special_rates sr JOIN @s v ON v.testtype = sr.testtype AND v.id = sr.testid
WHERE sr.mcccode = @mcc AND sr.rate = v.old_rate;
PRINT CONCAT('special rates updated: ', @@ROWCOUNT);

UPDATE dbo.tbl_med_mcc_unit_master SET RateType = @new, RateTypeBilling = @new WHERE id = @mcc;
PRINT CONCAT('UP0801 pointed at list ', @new);

COMMIT TRANSACTION;

SELECT (SELECT COUNT(*) FROM dbo.tbl_med_test_rates_with_pcc_type WHERE RateTypeId = @new) tests,
       (SELECT COUNT(*) FROM dbo.tbl_med_profile_rates_with_pcc_types WHERE RateTypeId = @new) profiles,
       (SELECT COUNT(*) FROM dbo.tbl_med_master_profile_rates_with_pcc_types WHERE RateTypeId = @new) packages,
       (SELECT RateType FROM dbo.tbl_med_mcc_unit_master WHERE id = @mcc) rate_type,
       (SELECT RateTypeBilling FROM dbo.tbl_med_mcc_unit_master WHERE id = @mcc) rate_type_billing;
