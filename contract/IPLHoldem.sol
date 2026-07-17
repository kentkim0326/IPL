// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract IPLHoldem {

    // ═══════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════
    address public owner;
    IERC20 public usdc;

    uint256 public constant RAKE_PCT       = 300;  // 3%   (basis points /10000)
    uint256 public constant REF1_PCT       = 150;  // 1.5%
    uint256 public constant REF2_PCT       = 50;   // 0.5%
    uint256 public constant RAKE_CAP       = 3 * 1e6;   // $3 (USDC 6 decimals)
    uint256 public constant BASIS          = 10000;

    // 유저 잔액 (in-platform balance)
    mapping(address => uint256) public balances;

    // 레퍼럴: user => referrer
    mapping(address => address) public referrer;

    // 레퍼럴 누적 수익
    mapping(address => uint256) public referralEarnings;

    // IPL 수익 (owner withdraw)
    uint256 public platformEarnings;

    // 게임 서버 권한 (서버만 settlePot 호출 가능)
    address public gameServer;

    // ═══════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event PotSettled(uint256 pot, address winner, uint256 rake);
    event ReferralSet(address indexed user, address indexed ref);
    event ReferralPaid(address indexed ref, uint256 amount, uint8 level);

    // ═══════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════
    constructor(address _usdc, address _gameServer) {
        owner = msg.sender;
        usdc = IERC20(_usdc);
        gameServer = _gameServer;
    }

    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }
    modifier onlyServer() { require(msg.sender == gameServer || msg.sender == owner, "Not server"); _; }

    // ═══════════════════════════════════════
    // DEPOSIT
    // ═══════════════════════════════════════
    function deposit(uint256 amount, address _referrer) external {
        require(amount > 0, "Zero amount");
        require(usdc.transferFrom(msg.sender, address(this), amount), "Transfer failed");

        balances[msg.sender] += amount;

        // 레퍼럴 등록 (최초 1회)
        if (_referrer != address(0) && _referrer != msg.sender && referrer[msg.sender] == address(0)) {
            referrer[msg.sender] = _referrer;
            emit ReferralSet(msg.sender, _referrer);
        }

        emit Deposited(msg.sender, amount);
    }

    // ═══════════════════════════════════════
    // WITHDRAW
    // ═══════════════════════════════════════
    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "Insufficient balance");
        balances[msg.sender] -= amount;
        require(usdc.transfer(msg.sender, amount), "Transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    // ═══════════════════════════════════════
    // SETTLE POT (게임 서버만 호출)
    // 게임 종료 시 서버가 승자와 팟 정보 전송
    // ═══════════════════════════════════════
    function settlePot(
        address winner,
        address[] calldata losers,
        uint256[] calldata contributions,  // 각 loser가 낸 금액
        uint256 totalPot
    ) external onlyServer {
        require(losers.length == contributions.length, "Mismatch");

        // 각 loser 잔액 차감
        for (uint i = 0; i < losers.length; i++) {
            require(balances[losers[i]] >= contributions[i], "Loser insufficient balance");
            balances[losers[i]] -= contributions[i];
        }

        // 레이크 계산 (3%, 캡 $3)
        uint256 rake = (totalPot * RAKE_PCT) / BASIS;
        if (rake > RAKE_CAP) rake = RAKE_CAP;

        uint256 winnerAmount = totalPot - rake;

        // 레퍼럴 지급
        uint256 ref1Amount = 0;
        uint256 ref2Amount = 0;

        address ref1 = referrer[winner];
        if (ref1 != address(0)) {
            ref1Amount = (totalPot * REF1_PCT) / BASIS;
            if (ref1Amount > rake) ref1Amount = rake / 2;
            referralEarnings[ref1] += ref1Amount;
            balances[ref1] += ref1Amount;
            emit ReferralPaid(ref1, ref1Amount, 1);

            address ref2 = referrer[ref1];
            if (ref2 != address(0)) {
                ref2Amount = (totalPot * REF2_PCT) / BASIS;
                if (ref1Amount + ref2Amount > rake) ref2Amount = rake - ref1Amount;
                referralEarnings[ref2] += ref2Amount;
                balances[ref2] += ref2Amount;
                emit ReferralPaid(ref2, ref2Amount, 2);
            }
        }

        // IPL 수익 = 레이크 - 레퍼럴
        platformEarnings += (rake - ref1Amount - ref2Amount);

        // 승자 지급
        balances[winner] += winnerAmount;

        emit PotSettled(totalPot, winner, rake);
    }

    // ═══════════════════════════════════════
    // OWNER FUNCTIONS
    // ═══════════════════════════════════════
    function withdrawPlatformEarnings() external onlyOwner {
        uint256 amt = platformEarnings;
        platformEarnings = 0;
        require(usdc.transfer(owner, amt), "Transfer failed");
    }

    function setGameServer(address _server) external onlyOwner {
        gameServer = _server;
    }

    function setOwner(address _owner) external onlyOwner {
        owner = _owner;
    }

    // ═══════════════════════════════════════
    // VIEW
    // ═══════════════════════════════════════
    function getBalance(address user) external view returns (uint256) {
        return balances[user];
    }

    function getReferrer(address user) external view returns (address) {
        return referrer[user];
    }
}
