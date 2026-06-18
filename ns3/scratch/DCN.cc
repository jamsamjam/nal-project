#include "ns3/applications-module.h"
#include "ns3/core-module.h"
#include "ns3/internet-module.h"
#include "ns3/ipv4-global-routing-helper.h"
#include "ns3/network-module.h"
#include "ns3/point-to-point-module.h"
#include "ns3/point-to-point-net-device.h"
#include "ns3/traffic-control-module.h"
#include "ns3/tcp-l4-protocol.h"

#include "CSVLogger.h"

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <queue>
#include <vector>

using namespace ns3;

static std::string
FormatCompactDouble(double value)
{
    std::ostringstream oss;
    oss << value;
    return oss.str();
}

static std::string
NormalizeRunTag(std::string runTag)
{
    for (auto& c : runTag)
    {
        if (c == '/' || c == ' ')
            c = '_';
    }
    return runTag;
}

NS_LOG_COMPONENT_DEFINE("FatTreeTopology");

static uint16_t basePort = 9000;

struct QueueMetrics
{
    uint32_t maxQueueSize = 0;
    uint32_t packetsLost = 0;
    uint32_t packetsQueued = 0; // accumulated count of packets that entered the queue
    double totalSojournTime = 0.0; // total time packets spent in queue = dequeue - enqueue
    uint32_t sojournSampleCount = 0;
};

struct PacketArrivalInfo
{
    uint32_t size = 0;
    int64_t enqueueTime = 0;
    int64_t dequeueTime = 0;
    bool logged = false;
};

struct LinkTraceData
{
    std::unordered_map<uint64_t, PacketArrivalInfo> arrivals;
    QueueMetrics metrics;
};

static std::unordered_map<std::string, LinkTraceData> tracesByLink;
static CsvLogger* g_csvLogger = nullptr;

struct WorkloadEntry
{
    uint32_t sizeBytes = 0;
    double cdf = 0.0;
};

struct WorkloadDistribution
{
    std::string name;
    double averageMessageBytes = 0.0;
    std::vector<WorkloadEntry> entries;

    uint32_t Sample(Ptr<UniformRandomVariable> rv) const
    {
        if (entries.empty())
            return 0;

        const double u = rv->GetValue();
        for (const auto& entry : entries)
        {
            if (u <= entry.cdf)
                return entry.sizeBytes;
        }
        return entries.back().sizeBytes;
    }
};

static WorkloadDistribution
LoadWorkloadDistribution(const std::string& workloadName)
{
    WorkloadDistribution distribution;
    distribution.name = workloadName;

    std::string filename = workloadName;
    if (filename.size() < 4 || filename.substr(filename.size() - 4) != ".txt")
        filename += ".txt";

    const std::filesystem::path workloadPath = std::filesystem::path("../workloads") / filename;
    std::ifstream input(workloadPath);
    if (!input.is_open())
    {
        throw std::runtime_error("Unable to open workload file: " + workloadPath.string());
    }

    input >> distribution.averageMessageBytes;
    if (!input.good() || distribution.averageMessageBytes <= 0.0)
    {
        throw std::runtime_error("Invalid average message size in workload file: " + workloadPath.string());
    }

    uint32_t sizeBytes = 0;
    double cdf = 0.0;
    while (input >> sizeBytes >> cdf)
    {
        distribution.entries.push_back({sizeBytes, std::clamp(cdf, 0.0, 1.0)});
    }

    if (distribution.entries.empty())
    {
        throw std::runtime_error("Workload file contains no CDF entries: " + workloadPath.string());
    }

    distribution.entries.back().cdf = 1.0;
    return distribution;
}

class PoissonWorkloadApp : public Application
{
public:
    static TypeId GetTypeId()
    {
        static TypeId tid = TypeId("PoissonWorkloadApp").SetParent<Application>().SetGroupName("Applications");
        return tid;
    }

    void Configure(uint32_t sourceHostId,
                   const std::vector<Ipv4Address>& hostAddresses,
                   uint16_t port,
                   double lambdaMessagesPerSecond,
                   const WorkloadDistribution& distribution)
    {
        m_sourceHostId = sourceHostId;
        m_hostAddresses = hostAddresses;
        m_port = port;
        m_lambdaMessagesPerSecond = lambdaMessagesPerSecond;
        m_distribution = distribution;
    }

private:
    void StartApplication() override
    {
        m_running = true;
        m_socketByHost.resize(m_hostAddresses.size());
        m_pendingBytesByHost.assign(m_hostAddresses.size(), 0);

        // Each host acts as an independent Poisson source
        // We pre-create one TCP socket per src-dest pair and reuse it
        for (uint32_t hostId = 0; hostId < m_hostAddresses.size(); ++hostId)
        {
            if (hostId == m_sourceHostId)
                continue;

            Ptr<Socket> socket = Socket::CreateSocket(GetNode(), TcpSocketFactory::GetTypeId());
            socket->SetConnectCallback(MakeCallback(&PoissonWorkloadApp::HandleConnect, this),
                                       MakeCallback(&PoissonWorkloadApp::HandleConnectFail, this));
            socket->Connect(InetSocketAddress(m_hostAddresses[hostId], m_port));
            socket->SetSendCallback(MakeCallback(&PoissonWorkloadApp::HandleSend, this));
            m_socketByHost[hostId] = socket;
            m_destinationHostIds.push_back(hostId);
        }

        m_interArrivalRv = CreateObject<ExponentialRandomVariable>();
        if (m_lambdaMessagesPerSecond > 0.0)
            m_interArrivalRv->SetAttribute("Mean", DoubleValue(1.0 / m_lambdaMessagesPerSecond));
        m_choiceRv = CreateObject<UniformRandomVariable>();

        ScheduleNextArrival();
    }

    void StopApplication() override
    {
        m_running = false;
        if (m_nextArrivalEvent.IsPending())
            Simulator::Cancel(m_nextArrivalEvent);

        for (auto& socket : m_socketByHost)
        {
            if (socket != nullptr)
            {
                socket->Close();
                socket = nullptr;
            }
        }
        m_socketByHost.clear();
        m_pendingBytesByHost.clear();
        m_destinationHostIds.clear();
    }

    void ScheduleNextArrival()
    {
        if (!m_running || m_lambdaMessagesPerSecond <= 0.0 || m_destinationHostIds.empty())
            return;

        // Poisson arrivals are implemented via exponentially distributed inter-arrival times
        // If N(t) ~ Poisson(lambda), then inter-arrival time ~ Exp(lambda)
        const double deltaSeconds = std::max(0.0, m_interArrivalRv->GetValue());
        m_nextArrivalEvent = Simulator::Schedule(Seconds(deltaSeconds), &PoissonWorkloadApp::GenerateMessage, this);
    }

    void GenerateMessage()
    {
        if (!m_running || m_destinationHostIds.empty())
            return;

        // On each Poisson arrival:
        // Randomly choose a destination host (except the source)
        const uint32_t destinationIndex =
            m_choiceRv->GetInteger(0, static_cast<uint32_t>(m_destinationHostIds.size() - 1));
        const uint32_t destinationHostId = m_destinationHostIds[destinationIndex];

        // Sample a message size from the workload
        const uint32_t messageBytes = m_distribution.Sample(m_choiceRv);
        if (messageBytes > 0)
        {
            // Generate one application message
            m_pendingBytesByHost[destinationHostId] += messageBytes;
            TrySend(destinationHostId);
        }

        ScheduleNextArrival();
    }

    void HandleSend(Ptr<Socket> socket, uint32_t)
    {
        const uint32_t destinationHostId = FindDestinationHostId(socket);
        if (destinationHostId != std::numeric_limits<uint32_t>::max())
            TrySend(destinationHostId);
    }

    void HandleConnect(Ptr<Socket> socket)
    {
        const uint32_t destinationHostId = FindDestinationHostId(socket);
        if (destinationHostId != std::numeric_limits<uint32_t>::max())
            TrySend(destinationHostId);
    }

    void HandleConnectFail(Ptr<Socket>)
    {
    }

    uint32_t FindDestinationHostId(Ptr<Socket> socket) const
    {
        for (uint32_t hostId = 0; hostId < m_socketByHost.size(); ++hostId)
        {
            if (m_socketByHost[hostId] == socket)
                return hostId;
        }
        return std::numeric_limits<uint32_t>::max();
    }

    void TrySend(uint32_t destinationHostId)
    {
        Ptr<Socket> socket = m_socketByHost[destinationHostId];
        if (socket == nullptr)
            return;

        while (m_pendingBytesByHost[destinationHostId] > 0)
        {
            const uint32_t bytesToSend =
                static_cast<uint32_t>(std::min<uint64_t>(m_pendingBytesByHost[destinationHostId], 64 * 1024));
            const int sent = socket->Send(Create<Packet>(bytesToSend));
            if (sent <= 0)
                break;
            m_pendingBytesByHost[destinationHostId] -= static_cast<uint64_t>(sent);
        }
    }

    uint32_t m_sourceHostId = 0;
    uint16_t m_port = 0;
    double m_lambdaMessagesPerSecond = 0.0;
    bool m_running = false;
    EventId m_nextArrivalEvent;
    WorkloadDistribution m_distribution;
    std::vector<Ipv4Address> m_hostAddresses;
    std::vector<uint32_t> m_destinationHostIds;
    std::vector<Ptr<Socket>> m_socketByHost;
    std::vector<uint64_t> m_pendingBytesByHost;
    Ptr<ExponentialRandomVariable> m_interArrivalRv;
    Ptr<UniformRandomVariable> m_choiceRv;
};

static void
QueueLenTrace(std::string linkId, uint32_t oldValue, uint32_t newValue)
{
    auto& trace = tracesByLink[linkId];
    trace.metrics.maxQueueSize = std::max(trace.metrics.maxQueueSize, newValue);
    if (newValue > oldValue)
        trace.metrics.packetsQueued += (newValue - oldValue);
}

static void
DropTrace(std::string linkId, Ptr<const QueueDiscItem> item)
{
    tracesByLink[linkId].metrics.packetsLost++;
}

static void
ArrivalTrace(std::string linkId, Ptr<const QueueDiscItem> item)
{
    Ptr<const Packet> packet = item->GetPacket();
    PacketArrivalInfo info;
    info.size = packet->GetSize();
    info.enqueueTime = Simulator::Now().GetNanoSeconds();

    // try_emplace: only insert if uid not already present
    tracesByLink[linkId].arrivals.try_emplace(packet->GetUid(), info);
}

static void
DequeueTrace(std::string linkId, Ptr<const Packet> packet)
{
    auto& trace = tracesByLink[linkId];
    uint64_t id = packet->GetUid();
    int64_t dequeueTime = Simulator::Now().GetNanoSeconds();

    auto it = trace.arrivals.find(id); // returns end() if not found
    if (it == trace.arrivals.end() || it->second.logged)
        // not recorded when enqueued or already logged
        return;

    it->second.dequeueTime = dequeueTime;

    double sojournMs = (dequeueTime - it->second.enqueueTime) * 1e-6;
    trace.metrics.totalSojournTime += sojournMs;
    trace.metrics.sojournSampleCount++;
}

static void
MacRxTrace(std::string linkId, Ptr<const Packet> packet)
{
    auto& trace = tracesByLink[linkId];
    uint64_t id = packet->GetUid();
    int64_t arriveTime = Simulator::Now().GetNanoSeconds();

    auto it = trace.arrivals.find(id);
    if (it == trace.arrivals.end() || it->second.logged || it->second.dequeueTime == 0)
        return;

    it->second.logged = true;

    if (g_csvLogger != nullptr)
        g_csvLogger->Log(linkId, CsvLogger::Row{id, it->second.size, it->second.enqueueTime, it->second.dequeueTime, arriveTime});
}

struct FatTreeLink
{
    uint32_t from;
    uint32_t to;
};

enum class NodeKind
{
    Host,
    Tor,
    Agg,
    Core
};

static uint32_t
ComputeMaxHostToHostHops(uint32_t numHosts, uint32_t totalNodes, const std::vector<FatTreeLink>& links)
{
    if (numHosts < 2 || totalNodes == 0)
        return 1;

    std::vector<std::vector<uint32_t>> adj(totalNodes);
    for (const auto& l : links)
    {
        if (l.from >= totalNodes || l.to >= totalNodes)
            continue;
        adj[l.from].push_back(l.to);
        adj[l.to].push_back(l.from);
    }

    uint32_t maxHops = 1;
    for (uint32_t src = 0; src < numHosts; ++src)
    {
        std::vector<int32_t> dist(totalNodes, -1);
        std::queue<uint32_t> q;
        dist[src] = 0;
        q.push(src);

        while (!q.empty())
        {
            uint32_t cur = q.front();
            q.pop();
            for (uint32_t nxt : adj[cur])
            {
                if (dist[nxt] != -1)
                    continue;
                dist[nxt] = dist[cur] + 1;
                q.push(nxt);
            }
        }

        for (uint32_t dst = 0; dst < numHosts; ++dst)
        {
            if (dst == src)
                continue;
            if (dist[dst] > static_cast<int32_t>(maxHops))
                maxHops = static_cast<uint32_t>(dist[dst]);
        }
    }
    return maxHops;
}

static uint64_t
MakeDirectedLinkKey(uint32_t from, uint32_t to)
{
    return (static_cast<uint64_t>(from) << 32) | static_cast<uint64_t>(to);
}

static std::vector<std::vector<uint32_t>>
BuildAdjacency(uint32_t totalNodes, const std::vector<FatTreeLink>& links)
{
    std::vector<std::vector<uint32_t>> adj(totalNodes);
    for (const auto& link : links)
    {
        if (link.from >= totalNodes || link.to >= totalNodes)
            continue;
        adj[link.from].push_back(link.to);
        adj[link.to].push_back(link.from);
    }
    return adj;
}

static std::unordered_map<uint64_t, uint32_t>
ComputeMaxDownstreamHostHopsPerDirectedLink(uint32_t numHosts,
                                            uint32_t totalNodes,
                                            const std::vector<FatTreeLink>& links)
{
    std::unordered_map<uint64_t, uint32_t> maxHopsByDirectedLink;
    if (totalNodes == 0)
        return maxHopsByDirectedLink;

    const auto adj = BuildAdjacency(totalNodes, links);
    std::vector<std::vector<int32_t>> allDistances(totalNodes, std::vector<int32_t>(totalNodes, -1));

    for (uint32_t src = 0; src < totalNodes; ++src)
    {
        std::queue<uint32_t> q;
        allDistances[src][src] = 0;
        q.push(src);

        while (!q.empty())
        {
            const uint32_t cur = q.front();
            q.pop();
            for (uint32_t nxt : adj[cur])
            {
                if (allDistances[src][nxt] != -1)
                    continue;
                allDistances[src][nxt] = allDistances[src][cur] + 1;
                q.push(nxt);
            }
        }
    }

    for (uint32_t src = 0; src < totalNodes; ++src)
    {
        for (uint32_t nxt : adj[src])
        {
            const uint64_t key = MakeDirectedLinkKey(src, nxt);
            uint32_t maxHops = 1;
            for (uint32_t dst = 0; dst < numHosts; ++dst)
            {
                if (dst == src)
                    continue;
                const int32_t srcToDstHops = allDistances[src][dst];
                const int32_t nxtToDstHops = allDistances[nxt][dst];
                if (srcToDstHops <= 0 || nxtToDstHops < 0)
                    continue;

                // This neighbor can be the first hop on a shortest path from src to dst.
                if (srcToDstHops == nxtToDstHops + 1)
                    maxHops = std::max(maxHops, static_cast<uint32_t>(srcToDstHops));
            }
            maxHopsByDirectedLink[key] = maxHops;
        }
    }

    return maxHopsByDirectedLink;
}

static uint64_t
ComputeQueueBytes(uint64_t linkRateBps, uint32_t maxRttHops, double perLinkDelaySeconds)
{
    const double maxRttSeconds = 2.0 * static_cast<double>(maxRttHops) * perLinkDelaySeconds;
    const double queueBytes = static_cast<double>(linkRateBps) * maxRttSeconds / 8.0;
    const double cappedQueueBytes = std::clamp(queueBytes,
                                               1.0,
                                               static_cast<double>(std::numeric_limits<uint32_t>::max()));
    return static_cast<uint64_t>(cappedQueueBytes);
}

struct DcnTopo
{
    uint32_t layers;
    uint32_t kPods;
    uint32_t torCount;
    uint32_t aggCount;
    uint32_t serversPerTor;
    uint32_t numHosts;
    uint32_t numTor;
    uint32_t numAgg;
    uint32_t numCore;
    uint32_t total;

    explicit DcnTopo(uint32_t layers,
                     uint32_t kPods,
                     uint32_t torCount,
                     uint32_t aggCount,
                     uint32_t serversPerTor)
        : layers(layers),
          kPods(kPods),
          torCount(torCount),
          aggCount(aggCount),
          serversPerTor(serversPerTor)
    {
        if (layers == 3)
        {
            uint32_t half = kPods / 2;
            numHosts = (kPods * kPods * kPods) / 4;
            numTor = (kPods * kPods) / 2;
            numAgg = (kPods * kPods) / 2;
            numCore = half * half;
        }
        else if (layers == 2)
        {
            numHosts = torCount * serversPerTor;
            numTor = torCount;
            numAgg = aggCount;
            numCore = 0;
        }
        else
        {
            numHosts = serversPerTor;
            numTor = 1;
            numAgg = 0;
            numCore = 0;
        }
        total = numHosts + numTor + numAgg + numCore;
    }

    uint32_t hostId(uint32_t pod, uint32_t tor, uint32_t pos) const
    {
        uint32_t half = kPods / 2;
        return pod * half * half + tor * half + pos;
    }

    uint32_t torId(uint32_t pod, uint32_t idx) const
    {
        uint32_t half = kPods / 2;
        return numHosts + pod * half + idx;
    }

    uint32_t aggId(uint32_t pod, uint32_t idx) const
    {
        uint32_t half = kPods / 2;
        return numHosts + numTor + pod * half + idx;
    }

    uint32_t coreId(uint32_t group, uint32_t idx) const
    {
        uint32_t half = kPods / 2;
        return numHosts + numTor + numAgg + group * half + idx;
    }

    std::vector<FatTreeLink> buildLinks() const
    {
        std::vector<FatTreeLink> links; // array that dynamically changes the size

        auto tor = [&](uint32_t a, uint32_t b) {
            links.push_back({a, b});
        };

        if (layers == 3)
        {
            uint32_t half = kPods / 2;
            for (uint32_t p = 0; p < kPods; p++)
                for (uint32_t e = 0; e < half; e++)
                    for (uint32_t h = 0; h < half; h++)
                        tor(hostId(p, e, h), torId(p, e));

            for (uint32_t p = 0; p < kPods; p++)
                for (uint32_t e = 0; e < half; e++)
                    for (uint32_t a = 0; a < half; a++)
                        tor(torId(p, e), aggId(p, a));

            for (uint32_t p = 0; p < kPods; p++)
                for (uint32_t a = 0; a < half; a++)
                    for (uint32_t j = 0; j < half; j++)
                        tor(aggId(p, a), coreId(a, j));
        }
        else if (layers == 2)
        {
            auto torNodeId = [&](uint32_t idx) { return numHosts + idx; };
            auto aggNodeId = [&](uint32_t idx) { return numHosts + numTor + idx; };
            for (uint32_t t = 0; t < torCount; t++)
            {
                for (uint32_t h = 0; h < serversPerTor; h++)
                {
                    uint32_t host = t * serversPerTor + h;
                    tor(host, torNodeId(t));
                }
                for (uint32_t a = 0; a < aggCount; a++)
                    tor(torNodeId(t), aggNodeId(a));
            }
        }
        else
        {
            uint32_t torNode = numHosts;
            for (uint32_t h = 0; h < numHosts; h++)
                tor(h, torNode);
        }

        return links;
    }

    NodeKind nodeKind(uint32_t nodeId) const
    {
        if (nodeId < numHosts)
            return NodeKind::Host;
        if (nodeId < numHosts + numTor)
            return NodeKind::Tor;
        if (nodeId < numHosts + numTor + numAgg)
            return NodeKind::Agg;
        return NodeKind::Core;
    }
};

static std::string
RateForLink(const DcnTopo& topo,
            const FatTreeLink& link,
            const std::string& serverToTorRate,
            const std::string& torToAggRate,
            const std::string& aggToCoreRate)
{
    const NodeKind from = topo.nodeKind(link.from);
    const NodeKind to = topo.nodeKind(link.to);

    if ((from == NodeKind::Host && to == NodeKind::Tor) || (from == NodeKind::Tor && to == NodeKind::Host))
        return serverToTorRate;

    if ((from == NodeKind::Tor && to == NodeKind::Agg) || (from == NodeKind::Agg && to == NodeKind::Tor))
        return torToAggRate;

    if ((from == NodeKind::Agg && to == NodeKind::Core) || (from == NodeKind::Core && to == NodeKind::Agg))
        return aggToCoreRate;

    return serverToTorRate;
}

int
main(int argc, char* argv[])
{
    uint32_t layers = 3;
    uint32_t k = 4;
    uint32_t torCount = 2;
    uint32_t aggCount = 2;
    uint32_t serversPerTor = 8;
    std::string csvBase = "../backend/output";
    std::string linkRate = "10Mbps";
    std::string serverToTorRate = "10Mbps";
    std::string torToAggRate = "10Mbps";
    std::string aggToCoreRate = "10Mbps";
    std::string linkDelay = "1ms";
    std::string tcpType = "ns3::TcpNewReno";
    std::string queueDiscType = "ns3::FifoQueueDisc";
    double redMinThresholdPct = 20.0;
    double redMaxThresholdPct = 60.0;
    double loadPct = 50.0;
    std::string workloadName = "Google_AllRPC";
    std::string runTag;
    double simTime = 10.0;

    CommandLine cmd(__FILE__);
    cmd.AddValue("layers", "Topology layers: 1, 2, or 3", layers);
    cmd.AddValue("k", "Fat-tree degree (even, e.g. 4 or 8)", k);
    cmd.AddValue("torCount", "Number of ToR switches for 2-layer topology", torCount);
    cmd.AddValue("aggCount", "Number of Aggregation switches for 2-layer topology", aggCount);
    cmd.AddValue("serversPerTor", "Servers per ToR for 1/2-layer topology", serversPerTor);
    cmd.AddValue("linkRate", "Link data rate", linkRate);
    cmd.AddValue("serverToTorRate", "Host-to-ToR link data rate", serverToTorRate);
    cmd.AddValue("torToAggRate", "ToR-to-Aggregation link data rate", torToAggRate);
    cmd.AddValue("aggToCoreRate", "Aggregation-to-Core link data rate", aggToCoreRate);
    cmd.AddValue("linkDelay", "Link propagation delay", linkDelay);
    cmd.AddValue("tcp", "TCP variant", tcpType);
    cmd.AddValue("queue", "QueueDisc type", queueDiscType);
    cmd.AddValue("redMinThresholdPct", "RED minimum threshold as a percent of queue capacity", redMinThresholdPct);
    cmd.AddValue("redMaxThresholdPct", "RED maximum threshold as a percent of queue capacity", redMaxThresholdPct);
    cmd.AddValue("load", "Per-source offered load as a percent of the server uplink", loadPct);
    cmd.AddValue("workload", "Workload CDF file stem under ../workloads", workloadName);
    cmd.AddValue("runTag", "Output run tag. If omitted, derive one from simulation parameters.", runTag);
    cmd.Parse(argc, argv);

    std::string tcpVariant = tcpType.substr(tcpType.rfind(':') + 1);
    std::string queueVariant = queueDiscType.substr(queueDiscType.rfind(':') + 1);
    if (serverToTorRate.empty())
        serverToTorRate = linkRate;
    if (torToAggRate.empty())
        torToAggRate = serverToTorRate;
    if (aggToCoreRate.empty())
        aggToCoreRate = torToAggRate;
    if (layers < 1 || layers > 3)
    {
        std::cerr << "layers must be 1, 2, or 3\n";
        return 1;
    }

    if (layers == 3 && (k < 2 || k % 2 != 0))
    {
        std::cerr << "k must be even and >= 2\n";
        return 1;
    }

    DcnTopo topo(layers, k, torCount, aggCount, serversPerTor);
    std::vector<FatTreeLink> links = topo.buildLinks();
    const auto maxDownstreamHostHopsByDirectedLink =
        ComputeMaxDownstreamHostHopsPerDirectedLink(topo.numHosts, topo.total, links);
    const uint32_t maxHostHops = ComputeMaxHostToHostHops(topo.numHosts, topo.total, links);
    const double linkDelaySeconds = Time(linkDelay).GetSeconds();
    const double maxRttSeconds = 2.0 * static_cast<double>(maxHostHops) * linkDelaySeconds;
    const double referenceDelaySeconds = MilliSeconds(1).GetSeconds();
    const double referenceRttSeconds = 2.0 * static_cast<double>(maxHostHops) * referenceDelaySeconds;
    const double minSimTimeSeconds = 1.0;
    const double maxSimTimeSeconds = 4.0;
    simTime = std::clamp(10.0 * (maxRttSeconds / referenceRttSeconds),
                         minSimTimeSeconds,
                         maxSimTimeSeconds);
    if (runTag.empty())
    {
        runTag = "L" + std::to_string(layers)
            + "_k" + std::to_string(k)
            + "_t" + std::to_string(torCount)
            + "_a" + std::to_string(aggCount)
            + "_s" + std::to_string(serversPerTor)
            + "_d" + linkDelay
            + "_rsta" + serverToTorRate
            + "_rta" + torToAggRate
            + "_rac" + aggToCoreRate
            + "_tcp" + tcpVariant
            + "_q" + queueVariant
            + "_load" + FormatCompactDouble(loadPct)
            + "_w" + workloadName;

        if (queueVariant == "RedQueueDisc")
        {
            runTag += "_redmin" + FormatCompactDouble(redMinThresholdPct)
                + "_redmax" + FormatCompactDouble(redMaxThresholdPct);
        }
    }

    runTag = NormalizeRunTag(runTag);
    std::string csvDir = csvBase + "/" + runTag;
    std::filesystem::create_directories(csvDir);
    const uint64_t bottleneckBps = std::min({DataRate(serverToTorRate).GetBitRate(),
                                             DataRate(torToAggRate).GetBitRate(),
                                             DataRate(aggToCoreRate).GetBitRate()});
    redMinThresholdPct = std::clamp(redMinThresholdPct, 0.0, 100.0);
    redMaxThresholdPct = std::clamp(redMaxThresholdPct, 0.0, 100.0);

    if (redMaxThresholdPct < redMinThresholdPct)
    {
        std::swap(redMinThresholdPct, redMaxThresholdPct);
    }

    const bool useRedQueue = (queueDiscType == "ns3::RedQueueDisc");
    const std::string actualQueueDiscType = queueDiscType;
    const bool useEcn = useRedQueue || (tcpVariant == "TcpDctcp");
    const uint64_t maxQueueBytesEstimate = ComputeQueueBytes(bottleneckBps, maxHostHops, linkDelaySeconds);
    const std::string initialQueueSizeStr = "1B";

    std::cout << "DCN layers=" << layers
              << " k=" << k
              << " tor=" << torCount
              << " agg=" << aggCount
              << " serversPerTor=" << serversPerTor
              << " hosts=" << topo.numHosts
              << " topoTor=" << topo.numTor
              << " topoAgg=" << topo.numAgg
              << " core=" << topo.numCore
              << " serverToTorRate=" << serverToTorRate
              << " torToAggRate=" << torToAggRate
              << " aggToCoreRate=" << aggToCoreRate
              << " loadPct=" << loadPct
              << " workload=" << workloadName
              << " maxHostHops=" << maxHostHops
              << " maxRttSeconds=" << maxRttSeconds
              << " simTime=" << simTime
              << " maxQueueBytes=" << maxQueueBytesEstimate
              << " redMinThresholdPct=" << redMinThresholdPct
              << " redMaxThresholdPct=" << redMaxThresholdPct
              << " queueDiscImpl=" << actualQueueDiscType
              << " links=" << links.size() << "\n";

    Config::SetDefault("ns3::Ipv4GlobalRouting::RandomEcmpRouting", BooleanValue(false));
    Config::SetDefault("ns3::TcpL4Protocol::SocketType", StringValue(tcpType));
    if (useEcn)
    {
        Config::SetDefault("ns3::TcpSocketBase::UseEcn", StringValue("On"));
    }
    Time::SetResolution(Time::NS);

    NodeContainer nodes;
    nodes.Create(topo.total);

    InternetStackHelper stack;
    stack.Install(nodes);

    TrafficControlHelper tch;
    if (useRedQueue)
    {
        // ns3/src/traffic-control/model/red-queue-disc.cc
        tch.SetRootQueueDisc(actualQueueDiscType,
                             "MaxSize",
                             StringValue(initialQueueSizeStr),
                             "MinTh",
                             DoubleValue(1.0),
                             "MaxTh",
                             DoubleValue(1.0),
                             "UseEcn",
                             BooleanValue(true),
                             "UseHardDrop",
                             BooleanValue(false),
                             "LinkBandwidth",
                             DataRateValue(DataRate(bottleneckBps)),
                             "LinkDelay",
                             TimeValue(Time(linkDelay)),
                             "MeanPktSize",
                             UintegerValue(1024));
    }
    else
    {
        tch.SetRootQueueDisc(actualQueueDiscType, "MaxSize", StringValue(initialQueueSizeStr));
    }

    struct LinkQdisc {
        uint32_t from, to;
        Ptr<QueueDisc> qdisc;
        Ptr<NetDevice> txDevice;
        Ptr<NetDevice> rxDevice;
    };

    std::vector<LinkQdisc> qdiscsByLink;
    std::vector<Ipv4InterfaceContainer> interfacesByLink;

    Ipv4AddressHelper address;
    for (size_t i = 0; i < links.size(); ++i)
    {
        const auto& link = links[i];
        const std::string perLinkRate =
            RateForLink(topo, link, serverToTorRate, torToAggRate, aggToCoreRate);
        const uint64_t perLinkRateBps = DataRate(perLinkRate).GetBitRate();
        NodeContainer pair(nodes.Get(link.from), nodes.Get(link.to));

        PointToPointHelper p2p;
        // set NIC capacity to 1p so we can observe qdisc only
        p2p.SetQueue("ns3::DropTailQueue", "MaxSize", StringValue("1p"));
        p2p.SetDeviceAttribute("DataRate", StringValue(perLinkRate));
        p2p.SetChannelAttribute("Delay", StringValue(linkDelay));

        NetDeviceContainer devices = p2p.Install(pair);
        if (topo.nodeKind(link.from) == NodeKind::Host)
        {
            devices.Get(0)->GetObject<PointToPointNetDevice>()->SetQueue(
                CreateObject<DropTailQueue<Packet>>());
        }
        if (topo.nodeKind(link.to) == NodeKind::Host)
        {
            devices.Get(1)->GetObject<PointToPointNetDevice>()->SetQueue(
                CreateObject<DropTailQueue<Packet>>());
        }
        QueueDiscContainer qdiscs = tch.Install(devices);
        for (uint32_t direction = 0; direction < 2; ++direction)
        {
            const uint32_t fromNode = direction == 0 ? link.from : link.to;
            const uint32_t toNode = direction == 0 ? link.to : link.from;
            const uint64_t key = MakeDirectedLinkKey(fromNode, toNode);
            const auto hopsIt = maxDownstreamHostHopsByDirectedLink.find(key);
            const uint32_t maxDownstreamHops =
                hopsIt != maxDownstreamHostHopsByDirectedLink.end() ? hopsIt->second : 1;
            const uint64_t queueBytes = ComputeQueueBytes(perLinkRateBps, maxDownstreamHops, linkDelaySeconds);
            Ptr<QueueDisc> qdisc = qdiscs.Get(direction);
            qdisc->SetMaxSize(QueueSize(QueueSizeUnit::BYTES, static_cast<uint32_t>(queueBytes)));

            if (useRedQueue)
            {
                qdisc->SetAttributeFailSafe("MinTh",
                                            DoubleValue(static_cast<double>(queueBytes) * redMinThresholdPct / 100.0));
                qdisc->SetAttributeFailSafe("MaxTh",
                                            DoubleValue(static_cast<double>(queueBytes) * redMaxThresholdPct / 100.0));
                qdisc->SetAttributeFailSafe("LinkBandwidth", DataRateValue(DataRate(perLinkRateBps)));
                qdisc->SetAttributeFailSafe("LinkDelay", TimeValue(Time(linkDelay)));
            }
        }
        qdiscsByLink.push_back({link.from, link.to, qdiscs.Get(0), devices.Get(0), devices.Get(1)});
        qdiscsByLink.push_back({link.to, link.from, qdiscs.Get(1), devices.Get(1), devices.Get(0)});

        // Address: 10.byte2.byte3.0/24
        uint32_t byte2 = (uint32_t)(i / 254) + 1;
        uint32_t byte3 = (uint32_t)(i % 254) + 1;
        std::string subnet = "10." + std::to_string(byte2) + "." + std::to_string(byte3) + ".0";
        address.SetBase(subnet.c_str(), "255.255.255.0");
        interfacesByLink.push_back(address.Assign(devices));
    }

    Ipv4GlobalRoutingHelper::PopulateRoutingTables();

    std::vector<Ipv4Address> hostAddr(topo.numHosts);
    for (uint32_t h = 0; h < topo.numHosts; h++)
        hostAddr[h] = nodes.Get(h)->GetObject<Ipv4>()->GetAddress(1, 0).GetLocal();

    PacketSinkHelper sinkHelper("ns3::TcpSocketFactory",
        InetSocketAddress(Ipv4Address::GetAny(), basePort));
    for (uint32_t h = 0; h < topo.numHosts; h++)
    {
        ApplicationContainer sink = sinkHelper.Install(nodes.Get(h));
        sink.Start(Seconds(0.0));
        sink.Stop(Seconds(simTime + 1.0));
    }
    const WorkloadDistribution workload = LoadWorkloadDistribution(workloadName);

    // load = target utilization of each server uplink (in percent)
    const double loadFraction = std::clamp(loadPct / 100.0, 0.0, 1.0);
    const double perSourceTargetBps = static_cast<double>(DataRate(serverToTorRate).GetBitRate()) * loadFraction;
    const double lambdaMessagesPerSecond =
        workload.averageMessageBytes > 0.0 ? perSourceTargetBps / (8.0 * workload.averageMessageBytes) : 0.0;

    for (uint32_t h = 0; h < topo.numHosts; h++)
    {
        Ptr<PoissonWorkloadApp> app = CreateObject<PoissonWorkloadApp>();
        app->Configure(h, hostAddr, basePort, lambdaMessagesPerSecond, workload);
        nodes.Get(h)->AddApplication(app);
        app->SetStartTime(Seconds(0.0));
        app->SetStopTime(Seconds(simTime));
    }

    CsvLogger csvLogger(csvDir);
    g_csvLogger = &csvLogger;

    const auto connectTraces = [&](Ptr<QueueDisc> qdisc,
                                    Ptr<NetDevice> txDevice,
                                    Ptr<NetDevice> rxDevice,
                                    const std::string& linkId) {
        qdisc->TraceConnectWithoutContext("PacketsInQueue", MakeBoundCallback(&QueueLenTrace, linkId));
        qdisc->TraceConnectWithoutContext("Drop", MakeBoundCallback(&DropTrace, linkId));
        qdisc->TraceConnectWithoutContext("Enqueue", MakeBoundCallback(&ArrivalTrace, linkId));

        txDevice->GetObject<PointToPointNetDevice>()
            ->GetQueue()
            ->TraceConnectWithoutContext("Dequeue", MakeBoundCallback(&DequeueTrace, linkId));

        rxDevice->TraceConnectWithoutContext("MacRx", MakeBoundCallback(&MacRxTrace, linkId));
    };

    for (const auto& lq : qdiscsByLink)
        connectTraces(lq.qdisc, lq.txDevice,lq.rxDevice, std::to_string(lq.from) + "-" + std::to_string(lq.to));

    Simulator::Stop(Seconds(simTime + 1.0)); // to allow processing of last packets
    Simulator::Run();

    csvLogger.CloseAll();
    g_csvLogger = nullptr;

    Simulator::Destroy();
    return 0;
}
