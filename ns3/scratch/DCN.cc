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
#include <iostream>
#include <numeric>
#include <string>
#include <tuple>
#include <unordered_map>
#include <queue>
#include <vector>

using namespace ns3;

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
    int64_t arriveTime = 0;
    bool logged = false;
};

struct LinkTraceData
{
    std::unordered_map<uint64_t, PacketArrivalInfo> arrivals;
    QueueMetrics metrics;
};

static std::unordered_map<std::string, LinkTraceData> tracesByLink;
static CsvLogger* g_csvLogger = nullptr;

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
        // not recorded when enqueued or alreadt logged
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
    std::string id; // "from-to"
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
        return numHosts + pod * half + idx; // TODO
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
            links.push_back({a, b, std::to_string(a) + "-" + std::to_string(b)});
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
    const double simTime = 10.0;

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
    cmd.Parse(argc, argv);

    std::string tcpVariant = tcpType.substr(tcpType.rfind(':') + 1);
    std::string queueVariant = queueDiscType.substr(queueDiscType.rfind(':') + 1);
    if (serverToTorRate.empty())
        serverToTorRate = linkRate;
    if (torToAggRate.empty())
        torToAggRate = serverToTorRate;
    if (aggToCoreRate.empty())
        aggToCoreRate = torToAggRate;
    std::string runTag = "L" + std::to_string(layers)
        + "_k" + std::to_string(k)
        + "_t" + std::to_string(torCount)
        + "_a" + std::to_string(aggCount)
        + "_s" + std::to_string(serversPerTor)
        + "_d" + linkDelay
        + "_rsta" + serverToTorRate
        + "_rta" + torToAggRate
        + "_rac" + aggToCoreRate
        + "_tcp" + tcpVariant
        + "_q" + queueVariant;
    
    for (auto& c : runTag) if (c == '/' || c == ' ') c = '_';
    std::string csvDir = csvBase + "/" + runTag;
    std::filesystem::create_directories(csvDir);

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
    const uint32_t maxHostHops = ComputeMaxHostToHostHops(topo.numHosts, topo.total, links);
    const double maxRttSeconds = 2.0 * static_cast<double>(maxHostHops) * Time(linkDelay).GetSeconds();
    const uint64_t bottleneckBps = std::min({DataRate(serverToTorRate).GetBitRate(),
                                             DataRate(torToAggRate).GetBitRate(),
                                             DataRate(aggToCoreRate).GetBitRate()});
    uint64_t bdpBytes = static_cast<uint64_t>(bottleneckBps * maxRttSeconds / 8.0);
    if (bdpBytes < 1) bdpBytes = 1;
    std::string queueSizeStr = std::to_string(bdpBytes) + "B";

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
              << " maxHostHops=" << maxHostHops
              << " maxRttSeconds=" << maxRttSeconds
              << " queueBytes=" << bdpBytes
              << " links=" << links.size() << "\n";

    Config::SetDefault("ns3::TcpL4Protocol::SocketType", StringValue(tcpType));
    Time::SetResolution(Time::NS);

    NodeContainer nodes;
    nodes.Create(topo.total);

    InternetStackHelper stack;
    stack.Install(nodes);

    TrafficControlHelper tch;
    tch.SetRootQueueDisc(queueDiscType, "MaxSize", StringValue(queueSizeStr)); // TODO

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
        NodeContainer pair(nodes.Get(link.from), nodes.Get(link.to));

        PointToPointHelper p2p;
        // set NIC capacity to 1p so we can observe qdisc only
        p2p.SetQueue("ns3::DropTailQueue", "MaxSize", StringValue("1p"));
        p2p.SetDeviceAttribute("DataRate",
                               StringValue(RateForLink(topo,
                                                       link,
                                                       serverToTorRate,
                                                       torToAggRate,
                                                       aggToCoreRate)));
        p2p.SetChannelAttribute("Delay", StringValue(linkDelay));

        NetDeviceContainer devices = p2p.Install(pair);
        QueueDiscContainer qdiscs = tch.Install(devices);
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

    // Random permutation traffic: host[i] -> host[perm[i]]
    Ptr<UniformRandomVariable> rng = CreateObject<UniformRandomVariable>();
    std::vector<uint32_t> perm(topo.numHosts);
    std::iota(perm.begin(), perm.end(), 0); // perm[i] = i

    // Fisher-Yates shuffle modern algorithm
    for (uint32_t i = topo.numHosts - 1; i > 0; i--)
    { 
        uint32_t j = static_cast<uint32_t>(rng->GetValue(0.0, static_cast<double>(i + 1)));
        std::swap(perm[i], perm[j]);
    }

    PacketSinkHelper sinkHelper("ns3::TcpSocketFactory",
        InetSocketAddress(Ipv4Address::GetAny(), basePort));
    for (uint32_t h = 0; h < topo.numHosts; h++)
    {
        ApplicationContainer sink = sinkHelper.Install(nodes.Get(h));
        sink.Start(Seconds(0.0));
        sink.Stop(Seconds(simTime + 1.0));
    }

    for (uint32_t h = 0; h < topo.numHosts; h++)
    {
        uint32_t dst = perm[h];
        if (dst == h)
            continue;

        Ipv4Address dstAddr = hostAddr[dst];

        // OnOffHelper: sends at constant rate when on, idle when off
        OnOffHelper onoff("ns3::TcpSocketFactory",
            InetSocketAddress(dstAddr, basePort));

        onoff.SetConstantRate(DataRate(serverToTorRate), 1024);
        onoff.SetAttribute("OnTime",  StringValue("ns3::ExponentialRandomVariable[Mean=0.5]"));
        onoff.SetAttribute("OffTime", StringValue("ns3::ExponentialRandomVariable[Mean=0.5]"));

        ApplicationContainer src = onoff.Install(nodes.Get(h));
        src.Start(Seconds(0.0));
        src.Stop(Seconds(simTime));
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
