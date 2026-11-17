import Foundation

struct Region: Identifiable, Hashable {
    let code: String
    let name: String
    var id: String { code }
}

/// Countries and US states for the "Where do you live?" step. Codes match the
/// backend (`accounts.country` is ISO 3166-1 alpha-2, `us_state` is the USPS code).
enum Regions {
    static let countries: [Region] = Locale.Region.isoRegions
        .map(\.identifier)
        .filter { $0.count == 2 && $0.allSatisfy { $0.isASCII && $0.isUppercase } }
        .compactMap { code in
            Locale.current.localizedString(forRegionCode: code).map { Region(code: code, name: $0) }
        }
        .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }

    /// The phone's region if it's a real country, else the US.
    static var defaultCountry: String {
        let code = Locale.current.region?.identifier ?? "US"
        return countries.contains { $0.code == code } ? code : "US"
    }

    static func countryName(_ code: String) -> String {
        countries.first { $0.code == code }?.name ?? code
    }

    static func stateName(_ code: String) -> String {
        usStates.first { $0.code == code }?.name ?? code
    }

    static let usStates: [Region] = [
        ("AL", "Alabama"), ("AK", "Alaska"), ("AZ", "Arizona"), ("AR", "Arkansas"),
        ("CA", "California"), ("CO", "Colorado"), ("CT", "Connecticut"), ("DE", "Delaware"),
        ("DC", "District of Columbia"), ("FL", "Florida"), ("GA", "Georgia"), ("HI", "Hawaii"),
        ("ID", "Idaho"), ("IL", "Illinois"), ("IN", "Indiana"), ("IA", "Iowa"),
        ("KS", "Kansas"), ("KY", "Kentucky"), ("LA", "Louisiana"), ("ME", "Maine"),
        ("MD", "Maryland"), ("MA", "Massachusetts"), ("MI", "Michigan"), ("MN", "Minnesota"),
        ("MS", "Mississippi"), ("MO", "Missouri"), ("MT", "Montana"), ("NE", "Nebraska"),
        ("NV", "Nevada"), ("NH", "New Hampshire"), ("NJ", "New Jersey"), ("NM", "New Mexico"),
        ("NY", "New York"), ("NC", "North Carolina"), ("ND", "North Dakota"), ("OH", "Ohio"),
        ("OK", "Oklahoma"), ("OR", "Oregon"), ("PA", "Pennsylvania"), ("RI", "Rhode Island"),
        ("SC", "South Carolina"), ("SD", "South Dakota"), ("TN", "Tennessee"), ("TX", "Texas"),
        ("UT", "Utah"), ("VT", "Vermont"), ("VA", "Virginia"), ("WA", "Washington"),
        ("WV", "West Virginia"), ("WI", "Wisconsin"), ("WY", "Wyoming"),
    ].map { Region(code: $0.0, name: $0.1) }
}
