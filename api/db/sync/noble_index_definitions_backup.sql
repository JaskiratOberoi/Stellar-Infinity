/*
 * noble_index_definitions_backup.sql
 *
 * REVERSAL SCRIPT. Captured 2026-08-18 01:45 UTC from the live Noble
 * database, before any index is disabled or dropped.
 *
 * 37 nonclustered index definitions across the three over-indexed tables:
 *   tbl_med_mcc_patient_test_result  (16 indexes, 57.8 GB on 21.4 GB of data)
 *   tbl_med_mcc_patient_samples      (13 indexes)
 *   tbl_med_mcc_patient_master       (12 indexes)
 *
 * Scripted from sys.indexes with key order, ASC/DESC, INCLUDE columns,
 * filter predicates, fill factor and lock options preserved, so a
 * recreated index is byte-for-byte the same definition.
 *
 * WARNING: recreating an index on the 68M-row result table is an OFFLINE
 * operation on Standard Edition - it takes a schema-modification lock for
 * the duration and blocks the table. Do it in a maintenance window, not
 * mid-shift.
 */

CREATE NONCLUSTERED INDEX [_dta_index_tbl_med_mcc_patient_master_5_818101955__K1_K25_K26_K4_K6_K2_5_8_19_22] ON dbo.[tbl_med_mcc_patient_master] ([id] ASC, [bill_number] ASC, [MRNID] ASC, [name] ASC, [gender] ASC, [mcc_code] ASC) INCLUDE ([age], [sample_time], [age_type], [order_number]) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [IX_patient_id] ON dbo.[tbl_med_mcc_patient_master] ([id] ASC, [mcc_code] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [IX_telo_patient_master_mobile_number] ON dbo.[tbl_med_mcc_patient_master] ([mobile_number] ASC) INCLUDE ([addedby]) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [NonClusteredIndex-20190418-133334] ON dbo.[tbl_med_mcc_patient_master] ([mcc_code] ASC, [ref_doctor] ASC, [ref_customer] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [NonClusteredIndex-20190704-214707] ON dbo.[tbl_med_mcc_patient_master] ([ref_doctor] ASC, [order_number] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [NonClusteredIndex-20190704-215902] ON dbo.[tbl_med_mcc_patient_master] ([addeddate] ASC, [mobile_number] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [NonClusteredIndex-20201231-221552] ON dbo.[tbl_med_mcc_patient_master] ([mcc_code] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [NonClusteredIndex-20201231-221621] ON dbo.[tbl_med_mcc_patient_master] ([name] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [NonClusteredIndex-20201231-221700] ON dbo.[tbl_med_mcc_patient_master] ([bill_number] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [NonClusteredIndex-20220426-072317] ON dbo.[tbl_med_mcc_patient_master] ([mcc_code] ASC, [addeddate] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [NonClusteredIndex-20220627-120951] ON dbo.[tbl_med_mcc_patient_master] ([order_patient_number] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [_dta_index_tbl_med_mcc_patient_samples_5_914102297__K11_K7_2_4_5_6_14_15_16_18_19] ON dbo.[tbl_med_mcc_patient_samples] ([modifieddate] ASC, [sample_status] ASC) INCLUDE ([patient_id], [testcodes], [testnames], [vailid], [Sample_Comments], [Sample_ClinicalHistory], [lastmodified_date], [department_id], [business_unit_id]) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [_dta_index_tbl_med_mcc_patient_samples_5_914102297__K2_K11_K7_4_5_6_14_15_16_18_19] ON dbo.[tbl_med_mcc_patient_samples] ([patient_id] ASC, [modifieddate] ASC, [sample_status] ASC) INCLUDE ([testcodes], [testnames], [vailid], [Sample_Comments], [Sample_ClinicalHistory], [lastmodified_date], [department_id], [business_unit_id]) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [_dta_index_tbl_med_mcc_patient_samples_5_914102297__K7_K9_K6_K2_4_5_11_14_15_18] ON dbo.[tbl_med_mcc_patient_samples] ([sample_status] ASC, [addeddate] ASC, [vailid] ASC, [patient_id] ASC) INCLUDE ([testcodes], [testnames], [modifieddate], [Sample_Comments], [Sample_ClinicalHistory], [department_id]) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [<Name of Missing Index, sysname,>] ON dbo.[tbl_med_mcc_patient_samples] ([sample_status] ASC, [modifieddate] ASC) INCLUDE ([vailid]) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [index_sample_stausmodified] ON dbo.[tbl_med_mcc_patient_samples] ([sample_status] ASC, [modifieddate] ASC) INCLUDE ([patient_id]) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [IX_patient_samples_vailid] ON dbo.[tbl_med_mcc_patient_samples] ([vailid] ASC, [patient_id] ASC, [sample_status] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [IX_samples_date] ON dbo.[tbl_med_mcc_patient_samples] ([modifieddate] ASC, [sample_status] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [NonClusteredIndex-20190418-133250] ON dbo.[tbl_med_mcc_patient_samples] ([patient_id] ASC, [addeddate] ASC, [modifieddate] ASC, [lastmodified_date] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [NonClusteredIndex-20211111-145746] ON dbo.[tbl_med_mcc_patient_samples] ([business_unit_id] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [NonClusteredIndex-20220614-120845] ON dbo.[tbl_med_mcc_patient_samples] ([modifieddate] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [NonClusteredIndex-20220614-120911] ON dbo.[tbl_med_mcc_patient_samples] ([vailid] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [_dta_index_tbl_med_mcc_patient_test_result_5_1010102639__K3_K19_1_4_6] ON dbo.[tbl_med_mcc_patient_test_result] ([vailid] ASC, [updateddate] ASC) INCLUDE ([id], [testid], [testtype]) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [_dta_index_tbl_med_mcc_patient_test_result_5_1010102639__K3_K2_K4_K1] ON dbo.[tbl_med_mcc_patient_test_result] ([vailid] ASC, [patientid] ASC, [testid] ASC, [id] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [_dta_index_tbl_med_mcc_patient_test_result_5_1010102639__K3_K4_K1] ON dbo.[tbl_med_mcc_patient_test_result] ([vailid] ASC, [testid] ASC, [id] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [_dta_index_tbl_med_mcc_patient_test_result_5_1010102639__K3_K4_K1_K6_K19] ON dbo.[tbl_med_mcc_patient_test_result] ([vailid] ASC, [testid] ASC, [id] ASC, [testtype] ASC, [updateddate] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [_dta_index_tbl_med_mcc_patient_test_result_5_1010102639__K7_K2_K1_K3_K2320_K4_K21_K6_5_12_13_14_15_22] ON dbo.[tbl_med_mcc_patient_test_result] ([auth] ASC, [patientid] ASC, [id] ASC, [vailid] ASC, [paramid] ASC, [testid] ASC, [profile_id] ASC, [testtype] ASC) INCLUDE ([value], [testname], [testnormal_range], [testunit], [comments], [abnormal]) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [index_result_vailid_patientid] ON dbo.[tbl_med_mcc_patient_test_result] ([vailid] ASC) INCLUDE ([patientid]) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [IX_patient_test_result_vailid] ON dbo.[tbl_med_mcc_patient_test_result] ([vailid] ASC, [auth] ASC) INCLUDE ([testid], [paramid], [profile_id], [patientid]) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [IX_result_vailid] ON dbo.[tbl_med_mcc_patient_test_result] ([vailid] ASC, [testid] ASC, [testcode] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [NonClusteredIndex-20190418-133420] ON dbo.[tbl_med_mcc_patient_test_result] ([patientid] ASC, [vailid] ASC, [testcode] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [NonClusteredIndex-20191102-143510] ON dbo.[tbl_med_mcc_patient_test_result] ([vailid] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [NonClusteredIndex-20191102-143530] ON dbo.[tbl_med_mcc_patient_test_result] ([patientid] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [NonClusteredIndex-20201231-214832] ON dbo.[tbl_med_mcc_patient_test_result] ([updateddate] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [NonClusteredIndex-20201231-221816] ON dbo.[tbl_med_mcc_patient_test_result] ([testid] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [NonClusteredIndex-20220108-153032] ON dbo.[tbl_med_mcc_patient_test_result] ([addeddate] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
CREATE NONCLUSTERED INDEX [NonClusteredIndex-20220328-212349] ON dbo.[tbl_med_mcc_patient_test_result] ([testtype] ASC, [UploadFlag] ASC) WITH (FILLFACTOR = 100, PAD_INDEX = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
