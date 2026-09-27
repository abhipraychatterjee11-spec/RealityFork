// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title RealityFork signed commitment registry
/// @notice Stores compact integrity anchors. It does not determine whether a claim is true.
contract RealityRegistry is AccessControl, EIP712 {
    enum Status { Active, Challenged, Merged, Superseded }

    struct Anchor {
        bytes32 commitHash;
        bytes32 evidenceRoot;
        bytes32 parentA;
        bytes32 parentB;
        address author;
        address relayer;
        address reviewer;
        uint64 createdAt;
        Status status;
    }

    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 public constant REVIEWER_ROLE = keccak256("REVIEWER_ROLE");
    bytes32 public constant COMMIT_AUTHORIZATION_V2_TYPEHASH = keccak256(
        "RealityCommitAuthorizationV2(bytes32 commitHash,bytes32 evidenceRoot,bytes32 parentA,bytes32 parentB,address author,uint256 nonce,uint64 expiresAt)"
    );
    bytes32 public constant CHALLENGE_AUTHORIZATION_TYPEHASH = keccak256(
        "RealityChallengeAuthorization(bytes32 challengeHash,bytes32 targetCommitHash,bytes32 challengeEvidenceRoot,address challenger,uint256 nonce,uint64 expiresAt)"
    );

    mapping(bytes32 commitHash => Anchor anchor) private _anchors;
    mapping(bytes32 commitHash => uint256 count) public challengeCount;
    mapping(address signer => mapping(uint256 nonce => bool used)) public usedNonces;
    mapping(bytes32 challengeHash => bool used) public usedChallengeHashes;

    error ZeroAddress();
    error ZeroCommitHash();
    error ZeroEvidenceRoot();
    error CommitAlreadyAnchored(bytes32 commitHash);
    error MissingParent(bytes32 parentHash);
    error InvalidParentArrangement();
    error DuplicateParents();
    error NonCanonicalParentOrder();
    error ParentSuperseded(bytes32 parentHash);
    error SignatureExpired(uint64 expiresAt);
    error NonceAlreadyUsed(address signer, uint256 nonce);
    error InvalidAuthorizationSigner(address expected, address recovered);
    error TargetCommitMissing(bytes32 commitHash);
    error TargetSuperseded(bytes32 commitHash);
    error ZeroChallengeHash();
    error ChallengeAlreadyAnchored(bytes32 challengeHash);

    event CommitAnchored(
        bytes32 indexed commitHash,
        address indexed author,
        address indexed relayer,
        bytes32 parentA,
        bytes32 parentB,
        bytes32 evidenceRoot,
        uint64 timestamp
    );
    event CommitChallenged(
        bytes32 indexed targetCommitHash,
        bytes32 indexed challengeHash,
        address indexed challenger,
        address relayer,
        bytes32 challengeEvidenceRoot,
        uint64 timestamp
    );
    event CommitMerged(
        bytes32 indexed mergeHash,
        bytes32 indexed parentA,
        bytes32 indexed parentB,
        address reviewer,
        bytes32 evidenceRoot,
        uint64 timestamp
    );

    constructor(address initialAdmin) EIP712("RealityFork", "2") {
        if (initialAdmin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
    }

    /// @notice Anchors a signed root or one-parent fork through an authorized relayer.
    function anchorSignedCommit(
        bytes32 commitHash,
        bytes32 evidenceRoot,
        bytes32 parentA,
        bytes32 parentB,
        address author,
        uint256 nonce,
        uint64 expiresAt,
        bytes calldata authorSignature
    ) external onlyRole(RELAYER_ROLE) {
        if (parentB != bytes32(0)) revert InvalidParentArrangement();
        _validateNewAnchor(commitHash, evidenceRoot);
        if (parentA != bytes32(0)) _validateForkParent(parentA);
        _verifyCommitAuthorizationV2(
            commitHash, evidenceRoot, parentA, bytes32(0), author, nonce, expiresAt, authorSignature
        );

        uint64 timestamp = uint64(block.timestamp);
        _anchors[commitHash] = Anchor(
            commitHash,
            evidenceRoot,
            parentA,
            bytes32(0),
            author,
            msg.sender,
            address(0),
            timestamp,
            Status.Active
        );
        emit CommitAnchored(commitHash, author, msg.sender, parentA, bytes32(0), evidenceRoot, timestamp);
    }

    /// @notice Anchors a signed, reviewed two-parent merge and supersedes both parents atomically.
    function anchorReviewedMerge(
        bytes32 mergeHash,
        bytes32 evidenceRoot,
        bytes32 parentA,
        bytes32 parentB,
        address author,
        uint256 nonce,
        uint64 expiresAt,
        bytes calldata authorSignature
    ) external onlyRole(REVIEWER_ROLE) {
        _validateNewAnchor(mergeHash, evidenceRoot);
        if (parentA == bytes32(0) || parentB == bytes32(0)) revert InvalidParentArrangement();
        if (parentA == parentB) revert DuplicateParents();
        _validateMergeParent(parentA);
        _validateMergeParent(parentB);
        if (parentA > parentB) revert NonCanonicalParentOrder();
        _verifyCommitAuthorizationV2(
            mergeHash, evidenceRoot, parentA, parentB, author, nonce, expiresAt, authorSignature
        );

        uint64 timestamp = uint64(block.timestamp);
        _anchors[mergeHash] = Anchor(
            mergeHash,
            evidenceRoot,
            parentA,
            parentB,
            author,
            address(0),
            msg.sender,
            timestamp,
            Status.Merged
        );
        _anchors[parentA].status = Status.Superseded;
        _anchors[parentB].status = Status.Superseded;

        emit CommitAnchored(mergeHash, author, address(0), parentA, parentB, evidenceRoot, timestamp);
        emit CommitMerged(mergeHash, parentA, parentB, msg.sender, evidenceRoot, timestamp);
    }

    /// @notice Anchors a signed challenge through an authorized relayer.
    function anchorSignedChallenge(
        bytes32 challengeHash,
        bytes32 targetCommitHash,
        bytes32 challengeEvidenceRoot,
        address challenger,
        uint256 nonce,
        uint64 expiresAt,
        bytes calldata challengerSignature
    ) external onlyRole(RELAYER_ROLE) {
        if (challengeHash == bytes32(0)) revert ZeroChallengeHash();
        if (challengeEvidenceRoot == bytes32(0)) revert ZeroEvidenceRoot();
        if (usedChallengeHashes[challengeHash]) revert ChallengeAlreadyAnchored(challengeHash);
        if (!_exists(targetCommitHash)) revert TargetCommitMissing(targetCommitHash);

        Anchor storage target = _anchors[targetCommitHash];
        if (target.status == Status.Superseded) revert TargetSuperseded(targetCommitHash);
        _verifyChallengeAuthorization(
            challengeHash,
            targetCommitHash,
            challengeEvidenceRoot,
            challenger,
            nonce,
            expiresAt,
            challengerSignature
        );

        usedChallengeHashes[challengeHash] = true;
        challengeCount[targetCommitHash] += 1;
        if (target.status == Status.Active) target.status = Status.Challenged;

        uint64 timestamp = uint64(block.timestamp);
        emit CommitChallenged(targetCommitHash, challengeHash, challenger, msg.sender, challengeEvidenceRoot, timestamp);
    }

    function getCommit(bytes32 commitHash) external view returns (Anchor memory) {
        return _requiredAnchor(commitHash);
    }

    function commitExists(bytes32 commitHash) external view returns (bool) {
        return _exists(commitHash);
    }

    function getCommitStatus(bytes32 commitHash) external view returns (Status) {
        return _requiredAnchor(commitHash).status;
    }

    function getCommitAuthor(bytes32 commitHash) external view returns (address) {
        return _requiredAnchor(commitHash).author;
    }

    function getCommitRelayer(bytes32 commitHash) external view returns (address) {
        return _requiredAnchor(commitHash).relayer;
    }

    function getCommitReviewer(bytes32 commitHash) external view returns (address) {
        return _requiredAnchor(commitHash).reviewer;
    }

    function getCommitParents(bytes32 commitHash) external view returns (bytes32 parentA, bytes32 parentB) {
        Anchor storage anchor = _requiredAnchor(commitHash);
        return (anchor.parentA, anchor.parentB);
    }

    function getEvidenceRoot(bytes32 commitHash) external view returns (bytes32) {
        return _requiredAnchor(commitHash).evidenceRoot;
    }

    function _validateNewAnchor(bytes32 commitHash, bytes32 evidenceRoot) private view {
        if (commitHash == bytes32(0)) revert ZeroCommitHash();
        if (evidenceRoot == bytes32(0)) revert ZeroEvidenceRoot();
        if (_exists(commitHash)) revert CommitAlreadyAnchored(commitHash);
    }

    function _validateMergeParent(bytes32 parentHash) private view {
        if (!_exists(parentHash)) revert MissingParent(parentHash);
        if (_anchors[parentHash].status == Status.Superseded) revert ParentSuperseded(parentHash);
    }

    function _validateForkParent(bytes32 parentHash) private view {
        if (!_exists(parentHash)) revert MissingParent(parentHash);
        if (_anchors[parentHash].status == Status.Superseded) revert ParentSuperseded(parentHash);
    }

    function _verifyCommitAuthorizationV2(
        bytes32 commitHash,
        bytes32 evidenceRoot,
        bytes32 parentA,
        bytes32 parentB,
        address author,
        uint256 nonce,
        uint64 expiresAt,
        bytes calldata signature
    ) private {
        if (author == address(0)) revert ZeroAddress();
        _validateNonceAndExpiry(author, nonce, expiresAt);
        bytes32 structHash = keccak256(
            abi.encode(
                COMMIT_AUTHORIZATION_V2_TYPEHASH,
                commitHash,
                evidenceRoot,
                parentA,
                parentB,
                author,
                nonce,
                expiresAt
            )
        );
        address recovered = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (recovered != author) revert InvalidAuthorizationSigner(author, recovered);
        usedNonces[author][nonce] = true;
    }

    function _verifyChallengeAuthorization(
        bytes32 challengeHash,
        bytes32 targetCommitHash,
        bytes32 challengeEvidenceRoot,
        address challenger,
        uint256 nonce,
        uint64 expiresAt,
        bytes calldata signature
    ) private {
        if (challenger == address(0)) revert ZeroAddress();
        _validateNonceAndExpiry(challenger, nonce, expiresAt);
        bytes32 structHash = keccak256(
            abi.encode(
                CHALLENGE_AUTHORIZATION_TYPEHASH,
                challengeHash,
                targetCommitHash,
                challengeEvidenceRoot,
                challenger,
                nonce,
                expiresAt
            )
        );
        address recovered = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (recovered != challenger) revert InvalidAuthorizationSigner(challenger, recovered);
        usedNonces[challenger][nonce] = true;
    }

    function _validateNonceAndExpiry(address signer, uint256 nonce, uint64 expiresAt) private view {
        if (block.timestamp >= expiresAt) revert SignatureExpired(expiresAt);
        if (usedNonces[signer][nonce]) revert NonceAlreadyUsed(signer, nonce);
    }

    function _exists(bytes32 commitHash) private view returns (bool) {
        return _anchors[commitHash].createdAt != 0;
    }

    function _requiredAnchor(bytes32 commitHash) private view returns (Anchor storage) {
        if (!_exists(commitHash)) revert TargetCommitMissing(commitHash);
        return _anchors[commitHash];
    }
}
