//! WoCo LikeAggregator (#5) — trustless trending over EAS like attestations.
//!
//! PULL model: anyone submits attestation UIDs; this contract verifies each one
//! against EAS itself (staticcall `getAttestation`), so no submitter is trusted
//! and no resolver is attached to the schema (the live #4 rail is untouched).
//! The server keeper is just the first submitter — any wallet can sync state,
//! which is the seam that lets the server drop out of the read AND write path.
//!
//! Counting rules (locked by the #4 abuse model):
//! - count = non-revoked attestations per subject, deduped by attester
//!   (one active (subject, attester) edge, keyed on-chain)
//! - subjects are first-class (namehash / onChainEventId) — never aggregated
//!   at the owner level
//! - `weight_of` is the unique-paid-payer weighting seam: v1 weights every
//!   attester 1; the applied weight is stored per edge so a future weighting
//!   change can never make removal asymmetric with the original add.
//!
//! Revocation is pulled, not pushed: submitting a revoked UID that is currently
//! counted uncounts it. `record` also self-heals the swap case (counted UID was
//! revoked on-chain, fresh attestation submitted) in a single call.

#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
#![cfg_attr(not(any(test, feature = "export-abi")), no_std)]

#[macro_use]
extern crate alloc;

use alloc::vec::Vec;
use alloy_primitives::{address, b256, Address, B256, U256, U64, U8};
use alloy_sol_types::{sol, SolCall};
use stylus_sdk::{prelude::*, stylus_core::calls::context::Call, stylus_core::log};

/// EAS on Arbitrum Sepolia (421614). Hardcoded — no initializer, no
/// init-frontrun surface; a different chain is a recompile, not a config.
const EAS_ADDRESS: Address = address!("2521021fc8BF070473E1e1801D3c7B4aB701E1dE");

/// Like schema UID: `bytes32 subject,uint8 subjectType`, resolver=0, revocable.
const SCHEMA_UID: B256 =
    b256!("62c5b546e61c567163dcb1af412ddd3b6f3a75dbb0da944e89ca2fbeb01dda64");

sol! {
    /// Mirrors EAS `Attestation` (Common.sol) — field order is the ABI contract.
    struct Attestation {
        bytes32 uid;
        bytes32 schema;
        uint64 time;
        uint64 expirationTime;
        uint64 revocationTime;
        bytes32 refUID;
        address recipient;
        address attester;
        bool revocable;
        bytes data;
    }

    function getAttestation(bytes32 uid) external view returns (Attestation memory);

    event LikeCounted(bytes32 indexed subject, uint8 subjectType, address indexed attester, bytes32 uid, uint64 weight);
    event LikeUncounted(bytes32 indexed subject, address indexed attester, bytes32 uid, uint64 weight);

    error AttestationNotFound();
    error SchemaMismatch();
    error MalformedAttestationData();
    error ExpiringAttestationUnsupported();
    error SubjectTypeMismatch();
    error EasCallFailed();
}

#[derive(SolidityError)]
pub enum AggregatorError {
    AttestationNotFound(AttestationNotFound),
    SchemaMismatch(SchemaMismatch),
    MalformedAttestationData(MalformedAttestationData),
    ExpiringAttestationUnsupported(ExpiringAttestationUnsupported),
    SubjectTypeMismatch(SubjectTypeMismatch),
    EasCallFailed(EasCallFailed),
}

impl core::fmt::Debug for AggregatorError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(match self {
            Self::AttestationNotFound(_) => "AttestationNotFound",
            Self::SchemaMismatch(_) => "SchemaMismatch",
            Self::MalformedAttestationData(_) => "MalformedAttestationData",
            Self::ExpiringAttestationUnsupported(_) => "ExpiringAttestationUnsupported",
            Self::SubjectTypeMismatch(_) => "SubjectTypeMismatch",
            Self::EasCallFailed(_) => "EasCallFailed",
        })
    }
}

sol_storage! {
    #[entrypoint]
    pub struct LikeAggregator {
        /// subject → weighted like count (sum of applied weights of active edges).
        mapping(bytes32 => uint64) counts;
        /// subject → SubjectType (0 profile / 1 event), pinned on first record.
        mapping(bytes32 => uint8) subject_types;
        /// subject → registered in `subjects` (subject_types 0 is a valid type,
        /// so existence needs its own flag).
        mapping(bytes32 => bool) known;
        /// Enumeration order for trending scans (append-only).
        bytes32[] subjects;
        /// subject → attester → counted attestation UID (0 = no active edge).
        /// UIDs are EAS keccak outputs, so 0 is a safe sentinel.
        mapping(bytes32 => mapping(address => bytes32)) active_uid;
        /// subject → attester → weight applied when the edge was counted.
        mapping(bytes32 => mapping(address => uint64)) applied_weight;
    }
}

/// Strict decode of the schema payload `(bytes32 subject, uint8 subjectType)`:
/// exactly two words, the second a canonically-padded uint8. Anything else is
/// foreign/garbage data under our schema UID and is rejected, not coerced.
fn decode_like_data(data: &[u8]) -> Result<(B256, u8), AggregatorError> {
    if data.len() != 64 {
        return Err(AggregatorError::MalformedAttestationData(MalformedAttestationData {}));
    }
    if data[32..63].iter().any(|b| *b != 0) {
        return Err(AggregatorError::MalformedAttestationData(MalformedAttestationData {}));
    }
    Ok((B256::from_slice(&data[0..32]), data[63]))
}

impl LikeAggregator {
    fn fetch_attestation(&self, uid: B256) -> Result<Attestation, AggregatorError> {
        let calldata = getAttestationCall { uid }.abi_encode();
        let ret = self
            .vm()
            .static_call(&Call::new(), EAS_ADDRESS, &calldata)
            .map_err(|_| AggregatorError::EasCallFailed(EasCallFailed {}))?;
        let decoded = getAttestationCall::abi_decode_returns(&ret, true)
            .map_err(|_| AggregatorError::EasCallFailed(EasCallFailed {}))?;
        Ok(decoded._0)
    }

    /// Unique-paid-payer weighting seam. v1: every attester weighs 1. A future
    /// version consults a paid-payer source (e.g. WoCoEventV2 purchase state or
    /// a payment-receipt attestation) so cheap-sybil likes rank below paying
    /// attendees. Removal always subtracts the STORED applied weight, so
    /// changing this function can never corrupt existing counts.
    fn weight_of(&self, _attester: Address) -> u64 {
        1
    }

    fn uncount(&mut self, subject: B256, attester: Address, uid: B256) {
        let weight = self.applied_weight.getter(subject).get(attester);
        let count = self.counts.get(subject);
        self.counts.setter(subject).set(count.saturating_sub(weight));
        self.active_uid.setter(subject).setter(attester).set(B256::ZERO);
        self.applied_weight.setter(subject).setter(attester).set(U64::ZERO);
        log(
            self.vm(),
            LikeUncounted { subject, attester, uid, weight: weight.to::<u64>() },
        );
    }

    fn record_inner(&mut self, uid: B256) -> Result<bool, AggregatorError> {
        let att = self.fetch_attestation(uid)?;
        if att.attester == Address::ZERO {
            return Err(AggregatorError::AttestationNotFound(AttestationNotFound {}));
        }
        if att.schema != SCHEMA_UID {
            return Err(AggregatorError::SchemaMismatch(SchemaMismatch {}));
        }
        // Our writer never sets an expiry; a counted-but-expiring attestation
        // would silently stop being true with no revoke poke to uncount it.
        if att.expirationTime != 0 {
            return Err(AggregatorError::ExpiringAttestationUnsupported(
                ExpiringAttestationUnsupported {},
            ));
        }
        let (subject, subject_type) = decode_like_data(&att.data)?;
        let attester = att.attester;
        let current = self.active_uid.getter(subject).get(attester);

        if att.revocationTime != 0 {
            // Revoked: uncount only if this exact UID is the counted edge.
            if current != uid {
                return Ok(false);
            }
            self.uncount(subject, attester, uid);
            return Ok(true);
        }

        // Active attestation.
        if current == uid {
            return Ok(false); // idempotent replay
        }
        if current != B256::ZERO {
            // Dedup by attester — unless the counted UID has since been revoked
            // on-chain, in which case swap to the fresh one in a single call.
            let counted = self.fetch_attestation(current)?;
            if counted.revocationTime == 0 {
                return Ok(false);
            }
            self.uncount(subject, attester, current);
        }

        if self.known.get(subject) {
            if self.subject_types.get(subject) != U8::from(subject_type) {
                return Err(AggregatorError::SubjectTypeMismatch(SubjectTypeMismatch {}));
            }
        } else {
            self.known.setter(subject).set(true);
            self.subject_types.setter(subject).set(U8::from(subject_type));
            self.subjects.push(subject);
        }

        let weight = self.weight_of(attester);
        self.active_uid.setter(subject).setter(attester).set(uid);
        self.applied_weight.setter(subject).setter(attester).set(U64::from(weight));
        let count = self.counts.get(subject);
        self.counts.setter(subject).set(count.saturating_add(U64::from(weight)));
        log(
            self.vm(),
            LikeCounted { subject, subjectType: subject_type, attester, uid, weight },
        );
        Ok(true)
    }
}

#[public]
impl LikeAggregator {
    /// The EAS instance this aggregator verifies against.
    pub fn eas(&self) -> Address {
        EAS_ADDRESS
    }

    /// The like schema this aggregator accepts.
    pub fn schema_uid(&self) -> B256 {
        SCHEMA_UID
    }

    /// Submit one attestation UID. Permissionless: state changes only according
    /// to what EAS reports for the UID. Returns true if counts changed.
    pub fn record(&mut self, uid: B256) -> Result<bool, AggregatorError> {
        self.record_inner(uid)
    }

    /// Submit many UIDs (backfill / reconcile). Reverts on the first invalid
    /// UID — keepers must submit clean batches. Returns how many changed state.
    pub fn record_batch(&mut self, uids: Vec<B256>) -> Result<u32, AggregatorError> {
        let mut changed = 0u32;
        for uid in uids {
            if self.record_inner(uid)? {
                changed += 1;
            }
        }
        Ok(changed)
    }

    /// Weighted like count for a subject.
    pub fn get_count(&self, subject: B256) -> u64 {
        self.counts.get(subject).to::<u64>()
    }

    /// The attestation UID currently counted for (subject, attester), 0 if none.
    pub fn get_active_uid(&self, subject: B256, attester: Address) -> B256 {
        self.active_uid.getter(subject).get(attester)
    }

    /// Number of subjects ever counted (subjects are never deleted; a subject
    /// at count 0 stays enumerable).
    pub fn total_subjects(&self) -> U256 {
        U256::from(self.subjects.len())
    }

    /// Enumerate subjects: (subject, subjectType, count). Zeroes past the end.
    pub fn get_subject_at(&self, index: U256) -> (B256, u8, u64) {
        let Some(subject) = self.subjects.get(index) else {
            return (B256::ZERO, 0, 0);
        };
        (
            subject,
            self.subject_types.get(subject).to::<u8>(),
            self.counts.get(subject).to::<u64>(),
        )
    }

    /// Top `limit` subjects of one type by weighted count, descending. O(n·k)
    /// selection over the subject list — view-only, so the scan costs nothing
    /// on-chain; callers (server today, clients directly tomorrow) read this in
    /// place of any server-side trending projection.
    pub fn get_trending(&self, subject_type: u8, limit: u32) -> (Vec<B256>, Vec<u64>) {
        let total = self.subjects.len();
        let want = U8::from(subject_type);

        let mut entries: Vec<(B256, u64)> = Vec::new();
        for i in 0..total {
            let Some(subject) = self.subjects.get(i) else { break };
            if self.subject_types.get(subject) != want {
                continue;
            }
            let count = self.counts.get(subject).to::<u64>();
            if count > 0 {
                entries.push((subject, count));
            }
        }

        let k = (limit as usize).min(entries.len());
        let mut subjects = Vec::with_capacity(k);
        let mut counts = Vec::with_capacity(k);
        for _ in 0..k {
            let mut best = 0usize;
            for (i, e) in entries.iter().enumerate() {
                if e.1 > entries[best].1 {
                    best = i;
                }
            }
            let (s, c) = entries.swap_remove(best);
            subjects.push(s);
            counts.push(c);
        }
        (subjects, counts)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use alloy_sol_types::SolValue;
    use stylus_sdk::testing::*;

    const ATTESTER_A: Address = address!("00000000000000000000000000000000000000Aa");
    const ATTESTER_B: Address = address!("00000000000000000000000000000000000000Bb");
    const SUBJECT_1: B256 =
        b256!("1111111111111111111111111111111111111111111111111111111111111111");
    const SUBJECT_2: B256 =
        b256!("2222222222222222222222222222222222222222222222222222222222222222");
    const UID_1: B256 =
        b256!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const UID_2: B256 =
        b256!("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const UID_3: B256 =
        b256!("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");

    fn like_data(subject: B256, subject_type: u8) -> Vec<u8> {
        let mut data = vec![0u8; 64];
        data[0..32].copy_from_slice(subject.as_slice());
        data[63] = subject_type;
        data
    }

    fn attestation(uid: B256, attester: Address, subject: B256, subject_type: u8) -> Attestation {
        Attestation {
            uid,
            schema: SCHEMA_UID,
            time: 1,
            expirationTime: 0,
            revocationTime: 0,
            refUID: B256::ZERO,
            recipient: Address::ZERO,
            attester,
            revocable: true,
            data: like_data(subject, subject_type).into(),
        }
    }

    fn mock_attestation(vm: &TestVM, att: &Attestation) {
        let calldata = getAttestationCall { uid: att.uid }.abi_encode();
        // Return encoding of `returns (Attestation memory)` = the struct as a
        // single-element sequence (offset head + tail, since it's dynamic).
        let ret = (att.clone(),).abi_encode_sequence();
        vm.mock_static_call(EAS_ADDRESS, calldata, Ok(ret));
    }

    fn revoked(mut att: Attestation) -> Attestation {
        att.revocationTime = 99;
        att
    }

    #[test]
    fn counts_active_attestation_once() {
        let vm = TestVM::default();
        let mut c = LikeAggregator::from(&vm);
        let att = attestation(UID_1, ATTESTER_A, SUBJECT_1, 1);
        mock_attestation(&vm, &att);

        assert!(c.record(UID_1).unwrap());
        assert_eq!(c.get_count(SUBJECT_1), 1);
        assert_eq!(c.get_active_uid(SUBJECT_1, ATTESTER_A), UID_1);
        assert_eq!(c.total_subjects(), U256::from(1));

        // idempotent replay
        assert!(!c.record(UID_1).unwrap());
        assert_eq!(c.get_count(SUBJECT_1), 1);
    }

    #[test]
    fn dedups_second_attestation_by_same_attester() {
        let vm = TestVM::default();
        let mut c = LikeAggregator::from(&vm);
        let att1 = attestation(UID_1, ATTESTER_A, SUBJECT_1, 1);
        let att2 = attestation(UID_2, ATTESTER_A, SUBJECT_1, 1);
        mock_attestation(&vm, &att1);
        mock_attestation(&vm, &att2);

        assert!(c.record(UID_1).unwrap());
        // dedup-on-count: same attester, second UID, first still active on-chain
        assert!(!c.record(UID_2).unwrap());
        assert_eq!(c.get_count(SUBJECT_1), 1);
        assert_eq!(c.get_active_uid(SUBJECT_1, ATTESTER_A), UID_1);
    }

    #[test]
    fn revoked_uid_uncounts_only_the_counted_edge() {
        let vm = TestVM::default();
        let mut c = LikeAggregator::from(&vm);
        let att = attestation(UID_1, ATTESTER_A, SUBJECT_1, 1);
        mock_attestation(&vm, &att);
        assert!(c.record(UID_1).unwrap());

        // never-counted revoked UID from another attester: no-op
        mock_attestation(&vm, &revoked(attestation(UID_3, ATTESTER_B, SUBJECT_1, 1)));
        assert!(!c.record(UID_3).unwrap());
        assert_eq!(c.get_count(SUBJECT_1), 1);

        // the counted UID revoked on-chain: uncounts
        mock_attestation(&vm, &revoked(att));
        assert!(c.record(UID_1).unwrap());
        assert_eq!(c.get_count(SUBJECT_1), 0);
        assert_eq!(c.get_active_uid(SUBJECT_1, ATTESTER_A), B256::ZERO);

        // replaying the revoked UID stays a no-op
        assert!(!c.record(UID_1).unwrap());
        assert_eq!(c.get_count(SUBJECT_1), 0);
    }

    #[test]
    fn self_heals_revoked_counted_uid_on_fresh_attestation() {
        let vm = TestVM::default();
        let mut c = LikeAggregator::from(&vm);
        let att1 = attestation(UID_1, ATTESTER_A, SUBJECT_1, 1);
        mock_attestation(&vm, &att1);
        assert!(c.record(UID_1).unwrap());

        // UID_1 gets revoked on-chain; user re-likes producing UID_2. A single
        // record(UID_2) must swap, not double-count and not no-op.
        mock_attestation(&vm, &revoked(att1));
        mock_attestation(&vm, &attestation(UID_2, ATTESTER_A, SUBJECT_1, 1));
        assert!(c.record(UID_2).unwrap());
        assert_eq!(c.get_count(SUBJECT_1), 1);
        assert_eq!(c.get_active_uid(SUBJECT_1, ATTESTER_A), UID_2);
    }

    #[test]
    fn rejects_wrong_schema_missing_expiring_and_malformed() {
        let vm = TestVM::default();
        let mut c = LikeAggregator::from(&vm);

        let mut wrong_schema = attestation(UID_1, ATTESTER_A, SUBJECT_1, 1);
        wrong_schema.schema = B256::ZERO;
        mock_attestation(&vm, &wrong_schema);
        assert!(matches!(c.record(UID_1), Err(AggregatorError::SchemaMismatch(_))));

        // EAS returns a zeroed struct for unknown UIDs
        let mut missing = attestation(UID_2, Address::ZERO, SUBJECT_1, 1);
        missing.schema = B256::ZERO;
        missing.data = alloc::vec![].into();
        mock_attestation(&vm, &missing);
        assert!(matches!(c.record(UID_2), Err(AggregatorError::AttestationNotFound(_))));

        let mut expiring = attestation(UID_3, ATTESTER_A, SUBJECT_1, 1);
        expiring.expirationTime = 12345;
        mock_attestation(&vm, &expiring);
        assert!(matches!(
            c.record(UID_3),
            Err(AggregatorError::ExpiringAttestationUnsupported(_))
        ));

        let mut malformed = attestation(UID_3, ATTESTER_A, SUBJECT_1, 1);
        malformed.expirationTime = 0;
        malformed.data = alloc::vec![0u8; 63].into();
        mock_attestation(&vm, &malformed);
        assert!(matches!(
            c.record(UID_3),
            Err(AggregatorError::MalformedAttestationData(_))
        ));

        assert_eq!(c.get_count(SUBJECT_1), 0);
    }

    #[test]
    fn rejects_subject_type_flip() {
        let vm = TestVM::default();
        let mut c = LikeAggregator::from(&vm);
        mock_attestation(&vm, &attestation(UID_1, ATTESTER_A, SUBJECT_1, 0));
        assert!(c.record(UID_1).unwrap());

        // same subject re-attested under the other type — collision guard
        mock_attestation(&vm, &attestation(UID_2, ATTESTER_B, SUBJECT_1, 1));
        assert!(matches!(c.record(UID_2), Err(AggregatorError::SubjectTypeMismatch(_))));
    }

    #[test]
    fn trending_ranks_by_count_within_type() {
        let vm = TestVM::default();
        let mut c = LikeAggregator::from(&vm);
        // SUBJECT_1 (event, 2 likes), SUBJECT_2 (event, 1 like)
        mock_attestation(&vm, &attestation(UID_1, ATTESTER_A, SUBJECT_1, 1));
        mock_attestation(&vm, &attestation(UID_2, ATTESTER_B, SUBJECT_1, 1));
        mock_attestation(&vm, &attestation(UID_3, ATTESTER_A, SUBJECT_2, 1));
        let changed = c.record_batch(alloc::vec![UID_1, UID_2, UID_3]).unwrap();
        assert_eq!(changed, 3);

        let (subjects, counts) = c.get_trending(1, 10);
        assert_eq!(subjects, alloc::vec![SUBJECT_1, SUBJECT_2]);
        assert_eq!(counts, alloc::vec![2, 1]);

        // profile leaderboard is independent — empty here
        let (p_subjects, _) = c.get_trending(0, 10);
        assert!(p_subjects.is_empty());

        // limit respected
        let (top1, top1_counts) = c.get_trending(1, 1);
        assert_eq!(top1, alloc::vec![SUBJECT_1]);
        assert_eq!(top1_counts, alloc::vec![2]);
    }
}
